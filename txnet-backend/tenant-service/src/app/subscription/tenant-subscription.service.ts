import { Injectable, Logger } from '@nestjs/common';
import {
  AdminAction,
  AuditTargetType,
  EntitlementSource,
  Prisma,
  TenantBillingModel,
  TenantBillingReasonType,
  TenantStatus,
  TenantSuspensionCause,
  TenantType,
} from '@prisma/client';
import { ResellerAccess, TenantBillingLedger, lockProductQuotaTerms, lockQuotaTerms, platformCurrencyOf, type ResellerActor } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { renewalDeadline } from '../renewal/tenant-renewal.service';
import { applyTenantStatus } from '../status/tenant-status.transition';
import { lockPackage, replacePackageEntitlements } from '../packages/package-entitlements';
import { planPackageChange, upgradeChargeReference, type PackageChangePlan } from './package-change';
import type { GrantGraceInput, PutSubscriptionInput, UpdateSubscriptionSettingsInput } from './tenant-subscription.schema';

/**
 * The platform owner puts a reseller on a package and period, and sets the
 * platform's trial length (F-018-e).
 *
 * **Only the platform owner**, checked on the app pool before the
 * cross-tenant pool is touched (ADR-0053) — a reseller's subscription and
 * entitlements are another tenant's rows.
 *
 * **The first package starts the trial:** `currentPeriodEnd` = now +
 * `trialDays`. A later change is `package-change.ts`'s (F-019-v7, ADR-0107
 * point 9): an upgrade applies at once, charged from the reseller's billing
 * wallet for the days left; a downgrade waits for the renewal (`next`). In a
 * trial or an unpaid period it applies at once and free, as before. The
 * platform owner's `PUT` and the reseller's own change are this one rule.
 *
 * **Entitlements follow the package.** In the same transaction, under locks
 * on the package (shared) and then the tenant row, the tenant's
 * `package_included` entitlements are replaced by the package's
 * `includedFeatureKeys` as read under that lock — so a concurrent package edit
 * (F-018-o) is either fully before or fully after. Entitlements from any other
 * source are untouched (`package-entitlements.ts`).
 *
 * **More time to pay** (F-019-g): `graceUntil` moves the renewal's suspension
 * deadline later and lifts a `non_payment` suspension at once. No money moves
 * and the period does not change — the reseller still owes it.
 */

export type TenantSubscriptionActor = { adminId: string; tenantId: string; ip: string };

export type SubscriptionView = {
  tenantId: string;
  packageId: string;
  packageName: string;
  billingModel: TenantBillingModel;
  currentPeriodEnd: Date;
  startedAt: Date;
  includedFeatureKeys: string[];
  /** The change waiting for the renewal (F-019-v7), or null. */
  next: { packageId: string; billingModel: TenantBillingModel } | null;
  /** What this change debited from the billing wallet, in the platform's currency; null when nothing was. */
  charged?: string | null;
};

/** What a change would do, without doing it (F-019-v7): the reseller's upgrade button. */
export type ChangeQuote = {
  when: PackageChangePlan['when'];
  /** Debited at once; null when nothing would be. */
  charge: string | null;
  currencyCode: string;
  balance: string;
  /** The period end after the change. */
  currentPeriodEnd: Date;
};

export type GraceView = {
  tenantId: string;
  currentPeriodEnd: Date;
  /** The renewal does not suspend before this. */
  graceUntil: Date;
  status: TenantStatus;
  suspensionCause: TenantSuspensionCause | null;
};

export type SubscriptionSettingsView = { trialDays: number; suspensionHoldDays: number; renewalGraceDays: number; quotaTimeZone: string };

export type TenantSubscriptionRejection =
  | 'not_platform_owner'
  | 'reseller_not_found'
  | 'reseller_terminated'
  | 'subscription_not_found'
  | 'package_not_found'
  | 'package_inactive'
  | 'package_not_sold_for_period'
  | 'insufficient_balance';

export class TenantSubscriptionRefused extends Error {
  constructor(
    readonly reason: TenantSubscriptionRejection,
    detail = '',
  ) {
    super(`tenant subscription refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'TenantSubscriptionRefused';
  }
}

/** The platform's one settings row (CHECK `id = 1`, migration `20260917001300_tenant_subscription`). */
const SETTINGS_ID = 1;
const DAY_MS = 86_400_000;
const SETTINGS = { trialDays: true, suspensionHoldDays: true, renewalGraceDays: true, quotaTimeZone: true } as const;

const PRICE_OF: Record<PutSubscriptionInput['billingModel'], 'monthlyPrice' | 'yearlyPrice'> = {
  subscription_monthly: 'monthlyPrice',
  subscription_yearly: 'yearlyPrice',
};

@Injectable()
export class TenantSubscriptionService {
  private readonly logger = new Logger(TenantSubscriptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly ledger: TenantBillingLedger,
    private readonly door: ResellerAccess,
  ) {}

  /** The platform owner: the first package starts the trial; a later one is a change (F-019-v7). */
  async put(actor: TenantSubscriptionActor, tenantId: string, input: PutSubscriptionInput): Promise<SubscriptionView> {
    await this.access(actor);
    return this.change({ userId: actor.adminId, ip: actor.ip }, tenantId, input, { mayStart: true });
  }

  /**
   * The reseller changes its own package (F-019-v7): a money decision, so the
   * door is `tenantBilling`, as its top-up and its overage cap. The same rule
   * as the platform owner's `PUT`; it never starts a subscription.
   */
  async changeOwn(actor: ResellerActor & { ip: string }, tenantId: string, input: PutSubscriptionInput): Promise<SubscriptionView> {
    const reseller = await this.door.admit(actor, tenantId, 'tenantBilling');
    return this.change({ userId: actor.userId, ip: actor.ip }, reseller.id, input, { mayStart: false });
  }

  /** What {@link changeOwn} would do now, writing nothing. A `read`: the owner, its team and the platform's staff. */
  async quoteOwn(actor: ResellerActor, tenantId: string, input: PutSubscriptionInput, now = new Date()): Promise<ChangeQuote> {
    const reseller = await this.door.admit(actor, tenantId, 'read');
    const pkg = await this.sellable(input);
    return this.all.$transaction(async (tx) => {
      const state = await this.state(tx, reseller.id);
      if (!state.current) throw new TenantSubscriptionRefused('subscription_not_found', reseller.id);
      if (!pkg.isActive && state.current.packageId !== pkg.id) throw new TenantSubscriptionRefused('package_inactive', pkg.name);
      const plan = this.plan(state, pkg, input, now);
      const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: reseller.id }, select: { cachedBalance: true } });
      return {
        when: plan.when,
        charge: plan.when === 'now' && plan.charge.gt(0) ? plan.charge.toFixed(2) : null,
        currencyCode: await platformCurrencyOf(tx),
        balance: (wallet?.cachedBalance ?? new Prisma.Decimal(0)).toFixed(2),
        currentPeriodEnd: plan.when === 'now' ? plan.periodEnd : state.current.currentPeriodEnd,
      };
    });
  }

  private async change(by: { userId: string; ip: string }, tenantId: string, input: PutSubscriptionInput, opts: { mayStart: boolean }): Promise<SubscriptionView> {
    const reseller = await this.reseller(tenantId);
    if (reseller.status === TenantStatus.terminated) throw new TenantSubscriptionRefused('reseller_terminated', tenantId);
    const pkg = await this.sellable(input);
    const now = new Date();

    const view = await this.all.$transaction(async (tx) => {
      await lockPackage(tx, pkg.id, 'share');
      const locked = await tx.tenantFeaturePackage.findUnique({ where: { id: pkg.id }, select: { includedFeatureKeys: true } });
      const keys = (locked?.includedFeatureKeys ?? pkg.includedFeatureKeys) as string[];
      await tx.$queryRaw`SELECT id FROM "tenant"."tenant" WHERE id = ${tenantId}::uuid FOR UPDATE`;
      // Read again under the lock: a concurrent change that won it has already moved the period or the package.
      const state = await this.state(tx, tenantId);
      const current = state.current;
      if (!current && !opts.mayStart) throw new TenantSubscriptionRefused('subscription_not_found', tenantId);
      // A deactivated package keeps the subscribers it has (F-018-d) and takes no new ones.
      if (!pkg.isActive && current?.packageId !== pkg.id) throw new TenantSubscriptionRefused('package_inactive', pkg.name);
      const before = current ? { packageId: current.packageId, billingModel: state.billingModel, next: nextOf(current) } : null;
      const audit = async (after: SubscriptionView) => {
        await tx.adminAuditLog.create({
          data: {
            tenantId,
            adminId: by.userId,
            action: AdminAction.tenant_subscription_set,
            targetEntityType: AuditTargetType.tenant,
            targetEntityId: tenantId,
            oldValue: before ? (JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue) : Prisma.JsonNull,
            newValue: JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue,
            adminIpAddress: by.ip,
          },
        });
        return after;
      };

      const plan: PackageChangePlan = current ? this.plan(state, pkg, input, now) : { when: 'now', charge: new Prisma.Decimal(0), periodEnd: new Date(now.getTime() + (await this.trialDays()) * DAY_MS) };
      if (current && plan.when !== 'now') {
        // `none` takes back a change that was waiting; `renewal` schedules this one in its place.
        const next = plan.when === 'renewal' ? { packageId: pkg.id, billingModel: input.billingModel } : null;
        if ((current.nextPackageId ?? null) !== (next?.packageId ?? null) || (current.nextBillingModel ?? null) !== (next?.billingModel ?? null)) {
          await tx.tenantSubscription.update({ where: { tenantId }, data: { nextPackageId: next?.packageId ?? null, nextBillingModel: next?.billingModel ?? null } });
        }
        const entitlements = await tx.tenantFeatureEntitlement.findMany({ where: { tenantId, source: EntitlementSource.package_included }, select: { featureKey: true } });
        return audit({
          tenantId,
          packageId: current.packageId,
          packageName: current.package.name,
          billingModel: state.billingModel,
          currentPeriodEnd: current.currentPeriodEnd,
          startedAt: current.createdAt,
          includedFeatureKeys: entitlements.map((e) => e.featureKey),
          next,
          charged: null,
        });
      }
      if (plan.when !== 'now') throw new Error('unreachable: a first package always starts now');

      const paid = current !== null && isPaid(state.status, current.currentPeriodEnd, now);
      if (plan.charge.gt(0)) {
        const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId }, select: { cachedBalance: true } });
        const balance = wallet?.cachedBalance ?? new Prisma.Decimal(0);
        if (balance.lt(plan.charge)) throw new TenantSubscriptionRefused('insufficient_balance', `${plan.charge.toFixed(2)} needed, ${balance.toFixed(2)} held`);
        await this.ledger.debit(tx, {
          tenantId,
          amount: plan.charge,
          reasonType: TenantBillingReasonType.subscription_upgrade_charge,
          referenceId: upgradeChargeReference(tenantId, current!.currentPeriodEnd, pkg.id, input.billingModel),
        });
      }
      if (paid) {
        // A paid upgrade starts the new package's terms at once (ADR-0107 points 8-9): the period's held terms go.
        await tx.resellerQuotaTermsLock.deleteMany({ where: { tenantId, periodEnd: current!.currentPeriodEnd } });
      } else if (current && current.packageId !== pkg.id) {
        // Another package in an unpaid period: the quotas it had hold until the renewal; a kinder package's apply at once (F-019-v3).
        await lockQuotaTerms(tx, { tenantIds: [tenantId] });
        // ...and the product quotas its old package sold it (F-019-v6).
        await lockProductQuotaTerms(tx, { tenantIds: [tenantId] });
      }
      const row = await tx.tenantSubscription.upsert({
        where: { tenantId },
        create: { tenantId, packageId: pkg.id, currentPeriodEnd: plan.periodEnd },
        update: { packageId: pkg.id, currentPeriodEnd: plan.periodEnd, nextPackageId: null, nextBillingModel: null },
        select: { currentPeriodEnd: true, createdAt: true },
      });
      if (state.billingModel !== input.billingModel) {
        await tx.tenant.update({ where: { id: tenantId }, data: { billingModel: input.billingModel } });
      }
      await replacePackageEntitlements(tx, [tenantId], keys);
      return audit({
        tenantId,
        packageId: pkg.id,
        packageName: pkg.name,
        billingModel: input.billingModel,
        currentPeriodEnd: row.currentPeriodEnd,
        startedAt: row.createdAt,
        includedFeatureKeys: keys,
        next: null,
        charged: plan.charge.gt(0) ? plan.charge.toFixed(2) : null,
      });
    });
    this.logger.log(`reseller ${tenantId} package ${pkg.id} (${input.billingModel}) by ${by.userId}: ${view.next ? 'at renewal' : view.charged ? `now, ${view.charged}` : 'now'}`);
    return view;
  }

  /** The package asked for exists and is sold for the period asked. */
  private async sellable(input: PutSubscriptionInput) {
    const pkg = await this.all.tenantFeaturePackage.findUnique({
      where: { id: input.packageId },
      select: { id: true, name: true, monthlyPrice: true, yearlyPrice: true, includedFeatureKeys: true, isActive: true },
    });
    if (!pkg) throw new TenantSubscriptionRefused('package_not_found', input.packageId);
    if (pkg[PRICE_OF[input.billingModel]] === null) {
      throw new TenantSubscriptionRefused('package_not_sold_for_period', `${pkg.name} ${input.billingModel}`);
    }
    return pkg;
  }

  /** The reseller's status, period and subscription, as `tx` sees them. */
  private async state(tx: Prisma.TransactionClient, tenantId: string) {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true, billingModel: true } });
    if (!tenant) throw new TenantSubscriptionRefused('reseller_not_found', tenantId);
    const current = await tx.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        packageId: true,
        currentPeriodEnd: true,
        createdAt: true,
        nextPackageId: true,
        nextBillingModel: true,
        package: { select: { name: true, monthlyPrice: true, yearlyPrice: true } },
      },
    });
    return { status: tenant.status, billingModel: tenant.billingModel, current };
  }

  private plan(
    state: Awaited<ReturnType<TenantSubscriptionService['state']>>,
    pkg: { id: string; monthlyPrice: Prisma.Decimal | null; yearlyPrice: Prisma.Decimal | null },
    input: PutSubscriptionInput,
    now: Date,
  ): PackageChangePlan {
    const current = state.current!;
    const fromField = PRICE_OF[state.billingModel as PutSubscriptionInput['billingModel']];
    const toField = PRICE_OF[input.billingModel];
    return planPackageChange({
      samePackage: current.packageId === pkg.id,
      from: {
        model: state.billingModel,
        price: fromField && current.package ? current.package[fromField] : null,
        priceForNewModel: current.package ? current.package[toField] : null,
      },
      to: { model: input.billingModel, price: pkg[toField] as Prisma.Decimal },
      periodEnd: current.currentPeriodEnd,
      paid: isPaid(state.status, current.currentPeriodEnd, now),
      now,
    });
  }

  async read(actor: TenantSubscriptionActor, tenantId: string): Promise<SubscriptionView> {
    await this.access(actor);
    const reseller = await this.reseller(tenantId);
    const row = await this.all.tenantSubscription.findUnique({
      where: { tenantId },
      select: { packageId: true, currentPeriodEnd: true, createdAt: true, nextPackageId: true, nextBillingModel: true, package: { select: { name: true } } },
    });
    if (!row) throw new TenantSubscriptionRefused('subscription_not_found', tenantId);
    const entitlements = await this.all.tenantFeatureEntitlement.findMany({
      where: { tenantId, source: EntitlementSource.package_included },
      select: { featureKey: true },
    });
    return {
      tenantId,
      packageId: row.packageId,
      packageName: row.package.name,
      billingModel: reseller.billingModel,
      currentPeriodEnd: row.currentPeriodEnd,
      startedAt: row.createdAt,
      includedFeatureKeys: entitlements.map((e) => e.featureKey),
      next: nextOf(row),
    };
  }

  /**
   * `graceUntil` = the latest of now, the renewal's own deadline and an earlier
   * `graceUntil`, plus `days` — so a grant never shortens the time already
   * given. One transaction under the tenant row's lock; a `non_payment`
   * suspension becomes `active` (a `manual` one is lifted only by hand); one
   * audit row; no ledger entry.
   */
  async grantGrace(actor: TenantSubscriptionActor, tenantId: string, input: GrantGraceInput, now = new Date()): Promise<GraceView> {
    await this.access(actor);
    const settings = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { renewalGraceDays: true } });
    if (!settings) throw new Error('tenant_subscription_setting row is missing — run the migrations');

    const view = await this.all.$transaction(async (tx) => {
      const [tenant] = await tx.$queryRaw<{ id: string; tenantType: TenantType; status: TenantStatus; suspensionCause: TenantSuspensionCause | null }[]>`
        SELECT id, "tenantType", status, "suspensionCause"
        FROM "tenant"."tenant"
        WHERE id = ${tenantId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!tenant || tenant.tenantType !== TenantType.reseller) throw new TenantSubscriptionRefused('reseller_not_found', tenantId);
      if (tenant.status === TenantStatus.terminated) throw new TenantSubscriptionRefused('reseller_terminated', tenantId);
      const sub = await tx.tenantSubscription.findUnique({ where: { tenantId }, select: { currentPeriodEnd: true, graceUntil: true } });
      if (!sub) throw new TenantSubscriptionRefused('subscription_not_found', tenantId);

      const deadline = renewalDeadline(sub.currentPeriodEnd, settings.renewalGraceDays, sub.graceUntil);
      const base = deadline > now ? deadline : now;
      const after = await tx.tenantSubscription.update({
        where: { tenantId },
        data: { graceUntil: new Date(base.getTime() + input.days * DAY_MS) },
        select: { currentPeriodEnd: true, graceUntil: true },
      });
      let status: TenantStatus = tenant.status;
      let suspensionCause = tenant.suspensionCause;
      if (status === TenantStatus.suspended && suspensionCause === TenantSuspensionCause.non_payment) {
        ({ status, suspensionCause } = await applyTenantStatus(tx, tenantId, {
          from: status,
          to: TenantStatus.active,
          reason: input.reason,
          actorUserId: actor.adminId,
          now,
        }));
      }
      const result: GraceView = { tenantId, currentPeriodEnd: after.currentPeriodEnd, graceUntil: after.graceUntil as Date, status, suspensionCause };
      await tx.adminAuditLog.create({
        data: {
          tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_subscription_grace,
          targetEntityType: AuditTargetType.tenant,
          targetEntityId: tenantId,
          oldValue: JSON.parse(JSON.stringify({ graceUntil: sub.graceUntil, status: tenant.status, suspensionCause: tenant.suspensionCause })) as Prisma.InputJsonValue,
          newValue: JSON.parse(JSON.stringify({ ...result, days: input.days, reason: input.reason })) as Prisma.InputJsonValue,
          adminIpAddress: actor.ip,
        },
      });
      return result;
    });
    this.logger.log(`reseller ${tenantId} given grace until ${view.graceUntil.toISOString()} by ${actor.adminId}`);
    return view;
  }

  async readSettings(actor: TenantSubscriptionActor): Promise<SubscriptionSettingsView> {
    await this.access(actor);
    const row = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: SETTINGS });
    if (!row) throw new Error('tenant_subscription_setting row is missing — run the migrations');
    return row;
  }

  async updateSettings(actor: TenantSubscriptionActor, input: UpdateSubscriptionSettingsInput): Promise<SubscriptionSettingsView> {
    await this.access(actor);
    return this.all.$transaction(async (tx) => {
      const before = await tx.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: SETTINGS });
      if (!before) throw new Error('tenant_subscription_setting row is missing — run the migrations');
      const after = await tx.tenantSubscriptionSetting.update({
        where: { id: SETTINGS_ID },
        data: {
          trialDays: input.trialDays,
          suspensionHoldDays: input.suspensionHoldDays,
          renewalGraceDays: input.renewalGraceDays,
          quotaTimeZone: input.quotaTimeZone,
          updatedByUserId: actor.adminId,
        },
        select: SETTINGS,
      });
      await tx.adminAuditLog.create({
        data: {
          tenantId: actor.tenantId,
          adminId: actor.adminId,
          action: AdminAction.tenant_subscription_setting_update,
          targetEntityType: AuditTargetType.tenant_subscription_setting,
          // The setting is the platform's, so its row is addressed by the platform owner's tenant.
          targetEntityId: actor.tenantId,
          oldValue: before,
          newValue: after,
          adminIpAddress: actor.ip,
        },
      });
      return after;
    });
  }

  private async trialDays(): Promise<number> {
    const row = await this.all.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { trialDays: true } });
    if (!row) throw new Error('tenant_subscription_setting row is missing — run the migrations');
    return row.trialDays;
  }

  private async reseller(id: string): Promise<{ id: string; status: TenantStatus; billingModel: TenantBillingModel }> {
    const row = await this.all.tenant.findFirst({
      where: { id, tenantType: TenantType.reseller, deletedAt: null },
      select: { id: true, status: true, billingModel: true },
    });
    if (!row) throw new TenantSubscriptionRefused('reseller_not_found', id);
    return row;
  }

  /** The platform owner's tenant — the same check as reseller administration. */
  private async access(actor: TenantSubscriptionActor): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new TenantSubscriptionRefused('not_platform_owner', 'subscription administration');
    }
  }
}

/** A trial has paid nothing yet, and a period already over is the renewal's to charge. */
function isPaid(status: TenantStatus, periodEnd: Date, now: Date): boolean {
  return status !== TenantStatus.trial && periodEnd > now;
}

function nextOf(row: { nextPackageId: string | null; nextBillingModel: TenantBillingModel | null }): SubscriptionView['next'] {
  return row.nextPackageId && row.nextBillingModel ? { packageId: row.nextPackageId, billingModel: row.nextBillingModel } : null;
}
