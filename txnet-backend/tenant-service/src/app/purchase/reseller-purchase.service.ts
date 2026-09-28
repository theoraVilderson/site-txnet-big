import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, TenantBillingModel, TenantBillingReasonType, TenantStatus, TenantType, UserStatus, WalletReasonType } from '@prisma/client';
import {
  InsufficientFunds,
  TenantBillingLedger,
  TenantBillingVersionConflict,
  WalletLedgerService,
  WalletVersionConflict,
  operatingCurrencyOf,
} from '@txnet-backend/shared-core';
import { randomBytes } from 'node:crypto';

import { lockPackage, replacePackageEntitlements } from '../packages/package-entitlements';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { PRICE_OF, addBillingPeriod, periodChargeReference } from '../renewal/tenant-renewal.service';
import { OwnerView, ResellerView, resellerHosts, slugInUse, writeReseller } from '../resellers/reseller-rows';
import { isReservedSlug } from '../resellers/reseller.schema';
import { applyTenantStatus } from '../status/tenant-status.transition';
import type { PurchaseInput } from './reseller-purchase.schema';
import { slugCandidates, slugFromName } from './slug-suggestion';

/**
 * A platform user buys a reseller package and becomes a reseller (F-019-h,
 * ADR-0061; user 2026-09-18: paid from the user wallet, the first period paid
 * and `active` at once, the slug suggested from a name and editable before
 * buying, one live reseller per user).
 *
 * **All or nothing, one transaction on the cross-tenant pool.** Under the
 * package's shared lock: the reseller's rows ({@link writeReseller}, the path
 * the platform owner's create takes), the buyer's wallet debit
 * (`reseller_purchase`, referenced by the new tenant), the price credited to
 * the reseller's billing wallet and charged from it as the first period
 * (`subscription_charge`, as a renewal would), the subscription one period
 * long, the package's entitlements, and `trial` -> `active`. A short wallet
 * throws inside it, so nothing it wrote commits and nothing is refunded.
 *
 * **Only a user of the platform owner's tenant** — the caller's tenant is read
 * on the app pool, and anyone else is refused before the cross-tenant pool is
 * touched (ADR-0053's order). The rows written are another tenant's, which RLS
 * refuses on the app pool; the buyer's own wallet is written on the same pool
 * so the two commit together, its `tenantId` named explicitly.
 */

export type PurchaseBuyer = { userId: string; tenantId: string; ip: string };

export type PurchaseView = ResellerView & { packageId: string; currentPeriodEnd: Date; charged: string; walletBalance: string };

/**
 * The reseller a buyer already holds (F-019-l): what `/resellers/buy` shows in
 * place of a form `already_reseller` would refuse. `package` and
 * `currentPeriodEnd` are null only for a reseller the platform owner created
 * and never put on a package.
 */
export type OwnedReseller = Pick<ResellerView, 'id' | 'slug' | 'status' | 'billingModel' | 'domains'> & {
  package: { id: string; name: string } | null;
  currentPeriodEnd: Date | null;
};

export type PackageOffer = {
  id: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  includedFeatureKeys: string[];
};

export type PurchaseRejection =
  | 'not_platform_user'
  | 'buyer_inactive'
  | 'already_reseller'
  | 'package_not_found'
  | 'package_inactive'
  | 'package_not_sold_for_period'
  | 'slug_taken'
  | 'insufficient_balance'
  | 'wallet_changed';

export class ResellerPurchaseRefused extends Error {
  constructor(
    readonly reason: PurchaseRejection,
    detail = '',
  ) {
    super(`reseller purchase refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ResellerPurchaseRefused';
  }
}

const PACKAGE_SELECT = {
  id: true,
  name: true,
  isActive: true,
  monthlyPrice: true,
  yearlyPrice: true,
  includedFeatureKeys: true,
} satisfies Prisma.TenantFeaturePackageSelect;

type PackageRow = Prisma.TenantFeaturePackageGetPayload<{ select: typeof PACKAGE_SELECT }>;

const OWNER_SELECT = { id: true, fullName: true, username: true, phoneNumber: true, status: true } satisfies Prisma.UserSelect;

@Injectable()
export class ResellerPurchaseService {
  private readonly logger = new Logger(ResellerPurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly wallets: WalletLedgerService,
    private readonly billing: TenantBillingLedger,
  ) {}

  /** The packages on sale: active ones, by name. */
  async packages(buyer: PurchaseBuyer): Promise<PackageOffer[]> {
    await this.access(buyer);
    const rows = await this.all.tenantFeaturePackage.findMany({ where: { isActive: true }, orderBy: { name: 'asc' }, select: PACKAGE_SELECT });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice?.toFixed(2) ?? null,
      yearlyPrice: p.yearlyPrice?.toFixed(2) ?? null,
      includedFeatureKeys: p.includedFeatureKeys as string[],
    }));
  }

  /**
   * The caller's live reseller, or `null` (F-019-l). Never a refusal for
   * having none: the page asks this to choose which of its two states to show.
   * "Live" is {@link liveReseller}, the rule `already_reseller` refuses on.
   */
  async mine(buyer: PurchaseBuyer): Promise<{ reseller: OwnedReseller | null }> {
    await this.access(buyer);
    const row = await this.all.tenant.findFirst({
      where: liveReseller(buyer.userId),
      select: {
        id: true,
        slug: true,
        status: true,
        billingModel: true,
        subscription: { select: { currentPeriodEnd: true, package: { select: { id: true, name: true } } } },
        domains: { select: { domainValue: true, domainType: true, purpose: true, verificationStatus: true } },
      },
    });
    if (!row) return { reseller: null };
    const { subscription, ...rest } = row;
    return { reseller: { ...rest, package: subscription?.package ?? null, currentPeriodEnd: subscription?.currentPeriodEnd ?? null } };
  }

  /** The slug a name suggests, or the first free one beside it. Advisory: the purchase checks again. */
  async suggestSlug(buyer: PurchaseBuyer, name: string): Promise<{ slug: string }> {
    await this.access(buyer);
    return { slug: await this.freeSlug(slugFromName(name)) };
  }

  async purchase(buyer: PurchaseBuyer, input: PurchaseInput, now = new Date()): Promise<PurchaseView> {
    await this.access(buyer);

    const offered = await this.all.tenantFeaturePackage.findUnique({ where: { id: input.packageId }, select: PACKAGE_SELECT });
    sellable(offered, input.billingModel);
    // The platform owner's tenant is the caller's: `access` just proved it.
    const person = await this.all.user.findFirst({ where: { id: buyer.userId, tenantId: buyer.tenantId, deletedAt: null }, select: OWNER_SELECT });
    if (!person || person.status !== UserStatus.active) throw new ResellerPurchaseRefused('buyer_inactive', buyer.userId);
    const owner: OwnerView = { id: person.id, fullName: person.fullName, username: person.username, phoneNumber: person.phoneNumber };
    if (await this.ownsReseller(this.all, buyer.userId)) throw new ResellerPurchaseRefused('already_reseller', buyer.userId);

    const slug = input.slug ?? (await this.freeSlug(slugFromName(input.name)));
    const hosts = resellerHosts(slug, this.domain());
    if (input.slug && (await slugInUse(this.all, slug, hosts[0]))) throw new ResellerPurchaseRefused('slug_taken', slug);

    try {
      const view = await this.all.$transaction(async (tx) => {
        // The lock order of every subscription write: the package first (`package-entitlements.ts`).
        await lockPackage(tx, input.packageId, 'share');
        const pkg = await tx.tenantFeaturePackage.findUnique({ where: { id: input.packageId }, select: PACKAGE_SELECT });
        const price = sellable(pkg, input.billingModel);
        // Again inside: a second purchase that committed since the check above.
        if (await this.ownsReseller(tx, buyer.userId)) throw new ResellerPurchaseRefused('already_reseller', buyer.userId);

        const reseller = await writeReseller(tx, this.redis, { slug, hosts, billingModel: input.billingModel, owner, actorId: buyer.userId, ip: buyer.ip });
        const paid = await this.wallets.debit(tx, {
          userId: buyer.userId,
          amount: price,
          // The buyer is the platform's user, so this is the platform's currency (ADR-0098 part 4).
          currencyCode: await operatingCurrencyOf(tx, buyer.tenantId),
          reasonType: WalletReasonType.reseller_purchase,
          referenceId: reseller.id,
          tenantId: buyer.tenantId,
        });
        // The payment reaches the reseller's billing wallet and pays its first period there, so its history reads as a renewal's.
        await this.billing.credit(tx, { tenantId: reseller.id, amount: price, reasonType: TenantBillingReasonType.reseller_purchase, referenceId: reseller.id });
        await this.billing.debit(tx, {
          tenantId: reseller.id,
          amount: price,
          reasonType: TenantBillingReasonType.subscription_charge,
          referenceId: periodChargeReference(reseller.id, now),
        });
        const currentPeriodEnd = addBillingPeriod(now, input.billingModel);
        await tx.tenantSubscription.create({ data: { tenantId: reseller.id, packageId: input.packageId, currentPeriodEnd } });
        await replacePackageEntitlements(tx, [reseller.id], (pkg as PackageRow).includedFeatureKeys as string[]);
        await applyTenantStatus(tx, reseller.id, {
          from: TenantStatus.trial,
          to: TenantStatus.active,
          reason: 'reseller_purchased',
          actorUserId: buyer.userId,
          now,
        });
        return {
          ...reseller,
          status: TenantStatus.active,
          billingBalance: '0.00',
          packageId: input.packageId,
          currentPeriodEnd,
          charged: price.toFixed(2),
          walletBalance: paid.balanceAfter.toFixed(2),
        };
      });
      this.logger.log(`reseller ${view.id} (${slug}) bought by ${buyer.userId}: package ${input.packageId}, ${input.billingModel}`);
      return view;
    } catch (e) {
      if (e instanceof InsufficientFunds) throw new ResellerPurchaseRefused('insufficient_balance', buyer.userId);
      if (e instanceof WalletVersionConflict || e instanceof TenantBillingVersionConflict) throw new ResellerPurchaseRefused('wallet_changed', buyer.userId);
      // Lost a race on `tenant.slug` or `tenant_domain.domainValue`.
      if ((e as { code?: string })?.code === 'P2002') throw new ResellerPurchaseRefused('slug_taken', slug);
      throw e;
    }
  }

  /** The one door: a user of the platform owner's tenant. A non-owner is refused before the cross-tenant pool is touched (ADR-0053). */
  private async access(buyer: PurchaseBuyer): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: buyer.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) throw new ResellerPurchaseRefused('not_platform_user', 'reseller purchase');
  }

  /** A reseller the user owns that is not terminated or deleted: one live reseller per user. */
  private async ownsReseller(db: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const held = await db.tenant.findFirst({ where: liveReseller(userId), select: { id: true } });
    return Boolean(held);
  }

  /** The first of `base`, `base-2` … that is neither reserved nor held; past those, a random suffix. */
  private async freeSlug(base: string): Promise<string> {
    const domain = this.domain();
    const candidates = slugCandidates(base).filter((s) => !isReservedSlug(s));
    const hostOf = new Map(candidates.map((s) => [resellerHosts(s, domain)[0], s]));
    const [bySlug, byHost] = await Promise.all([
      this.all.tenant.findMany({ where: { slug: { in: candidates } }, select: { slug: true } }),
      this.all.tenantDomain.findMany({ where: { domainValue: { in: [...hostOf.keys()] } }, select: { domainValue: true } }),
    ]);
    const held = new Set([...bySlug.map((t) => t.slug), ...byHost.map((d) => hostOf.get(d.domainValue))]);
    return candidates.find((s) => !held.has(s)) ?? `${base}-${randomBytes(3).toString('hex')}`;
  }

  private domain(): string {
    return this.config.get<string>('DOMAIN_NAME') as string;
  }
}

/** A reseller the user owns that is not terminated or deleted — what "one live reseller per user" counts. */
function liveReseller(userId: string) {
  return { ownerUserId: userId, tenantType: TenantType.reseller, deletedAt: null, status: { not: TenantStatus.terminated } } satisfies Prisma.TenantWhereInput;
}

/** The package's price for the period, or the refusal that says why it is not on sale. */
function sellable(pkg: PackageRow | null, model: TenantBillingModel): Prisma.Decimal {
  if (!pkg) throw new ResellerPurchaseRefused('package_not_found');
  if (!pkg.isActive) throw new ResellerPurchaseRefused('package_inactive', pkg.name);
  const field = PRICE_OF[model];
  const price = field ? pkg[field] : null;
  if (!price) throw new ResellerPurchaseRefused('package_not_sold_for_period', `${pkg.name} ${model}`);
  return price;
}
