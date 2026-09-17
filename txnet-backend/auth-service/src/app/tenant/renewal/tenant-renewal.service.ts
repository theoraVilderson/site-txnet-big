import { Injectable, Logger } from '@nestjs/common';
import { Prisma, TenantBillingModel, TenantBillingReasonType, TenantStatus, TenantSuspensionCause, TenantType } from '@prisma/client';
import { OutboxEventType, TenantBillingLedger } from '@txnet-backend/shared-core';
import { createHash } from 'node:crypto';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { applyTenantStatus } from '../status/tenant-status.transition';
import { lockPackage, replacePackageEntitlements } from '../subscription/package-entitlements';

/**
 * A reseller's subscription renewed from its billing wallet (F-019-c, D-41;
 * tenant invariant 19, `rules.md` #10-#13).
 *
 * Called for every due subscription by the worker's sweep, and for one tenant
 * when its wallet is credited (`tenant.billing.credited`). Both are
 * at-least-once, so `renew` is safe to repeat: the charge and the new
 * `currentPeriodEnd` commit together, and the charge's reference is fixed by
 * the period it pays for (invariant 15 stands behind the lock).
 *
 * **One transaction on the cross-tenant pool, the package locked (shared) and
 * then the tenant row** — the lock order of every subscription write
 * (`package-entitlements.ts`).
 *
 * - **Paid:** the package's price for the tenant's period is debited
 *   (`subscription_charge`), `currentPeriodEnd` moves one calendar period on —
 *   from the old end, or from now after a non-payment suspension (user,
 *   2026-09-17) — the package's keys replace the `package_included`
 *   entitlements (F-018-o's removals take effect here), and `trial` or a
 *   `non_payment` suspension becomes `active`. A manual suspension stays.
 * - **Short:** until `currentPeriodEnd` + `renewalGraceDays` — or the platform
 *   owner's later `graceUntil` (F-019-g) — the owner is
 *   warned at most once a day; after it the tenant is suspended as
 *   `non_payment`. Each notice is an outbox row in the transaction. Nothing is
 *   deleted.
 */

export type RenewalOutcome = 'renewed' | 'warned' | 'suspended' | 'waiting' | 'not_due' | 'skipped';
export type RenewalSweep = { due: number; failed: number } & Record<RenewalOutcome, number>;

const SETTINGS_ID = 1;
const DAY_MS = 86_400_000;
/** Due subscriptions taken per sweep, oldest first; the rest wait one tick. */
const SWEEP_BATCH = 500;

const PRICE_OF: Partial<Record<TenantBillingModel, 'monthlyPrice' | 'yearlyPrice'>> = {
  subscription_monthly: 'monthlyPrice',
  subscription_yearly: 'yearlyPrice',
};
const MONTHS_OF: Partial<Record<TenantBillingModel, number>> = { subscription_monthly: 1, subscription_yearly: 12 };

type LockedTenant = {
  id: string;
  tenantType: TenantType;
  status: TenantStatus;
  suspensionCause: TenantSuspensionCause | null;
  billingModel: TenantBillingModel;
  ownerUserId: string;
};

/** `from` plus one calendar period (UTC), clamped to the month's last day: Jan 31 -> Feb 28. */
export function addBillingPeriod(from: Date, model: TenantBillingModel): Date {
  const months = MONTHS_OF[model];
  if (!months) throw new Error(`billing model ${model} has no subscription period`);
  const target = new Date(from.getTime());
  const day = target.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/**
 * When an unpaid renewal suspends the reseller: `renewalGraceDays` after the
 * period end, or the platform owner's `graceUntil` if that is later (F-019-g).
 */
export function renewalDeadline(periodEnd: Date, renewalGraceDays: number, graceUntil: Date | null): Date {
  const byGrace = new Date(periodEnd.getTime() + renewalGraceDays * DAY_MS);
  return graceUntil && graceUntil > byGrace ? graceUntil : byGrace;
}

/** The charge's `referenceId`: a name-based UUID of the tenant and the period end it pays for, so a period is charged once. */
export function periodChargeReference(tenantId: string, periodEnd: Date): string {
  const h = createHash('sha1').update(`tenant-subscription:${tenantId}:${periodEnd.toISOString()}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class TenantRenewalService {
  private readonly logger = new Logger(TenantRenewalService.name);

  constructor(
    private readonly all: CrossTenantPrismaService,
    private readonly ledger: TenantBillingLedger,
  ) {}

  /** Every due subscription of a reseller that is not terminated, one transaction each; one failing tenant never stops the rest. */
  async renewDue(now = new Date()): Promise<RenewalSweep> {
    const due = await this.all.tenantSubscription.findMany({
      where: {
        currentPeriodEnd: { lte: now },
        tenant: { tenantType: TenantType.reseller, deletedAt: null, status: { not: TenantStatus.terminated } },
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: SWEEP_BATCH,
      select: { tenantId: true },
    });
    const sweep: RenewalSweep = { due: due.length, failed: 0, renewed: 0, warned: 0, suspended: 0, waiting: 0, not_due: 0, skipped: 0 };
    for (const { tenantId } of due) {
      try {
        sweep[await this.renew(tenantId, now)] += 1;
      } catch (err) {
        sweep.failed += 1;
        this.logger.error(`renewal of tenant ${tenantId} failed: ${(err as Error).message}`);
      }
    }
    return sweep;
  }

  async renew(tenantId: string, now = new Date()): Promise<RenewalOutcome> {
    const peek = await this.all.tenantSubscription.findUnique({ where: { tenantId }, select: { currentPeriodEnd: true } });
    if (!peek) return 'skipped';
    if (peek.currentPeriodEnd > now) return 'not_due';
    const settings = await this.all.tenantSubscriptionSetting.findUnique({
      where: { id: SETTINGS_ID },
      select: { renewalGraceDays: true, suspensionHoldDays: true },
    });
    if (!settings) throw new Error('tenant_subscription_setting row is missing — run the migrations');

    const outcome = await this.all.$transaction(async (tx) => {
      const sub = await tx.tenantSubscription.findUnique({ where: { tenantId }, select: { packageId: true } });
      if (!sub) return 'skipped';
      await lockPackage(tx, sub.packageId, 'share');
      const [tenant] = await tx.$queryRaw<LockedTenant[]>`
        SELECT id, "tenantType", status, "suspensionCause", "billingModel", "ownerUserId"
        FROM "tenant"."tenant"
        WHERE id = ${tenantId}::uuid AND "deletedAt" IS NULL
        FOR UPDATE`;
      if (!tenant || tenant.tenantType !== TenantType.reseller || tenant.status === TenantStatus.terminated) return 'skipped';
      // Read again under both locks: a subscription `PUT` or a sweep that won the lock may have moved it.
      const current = await tx.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          packageId: true,
          currentPeriodEnd: true,
          renewalWarnedAt: true,
          graceUntil: true,
          package: { select: { monthlyPrice: true, yearlyPrice: true, includedFeatureKeys: true } },
        },
      });
      if (!current || current.packageId !== sub.packageId) throw new Error(`tenant ${tenantId} changed package during its renewal`);
      if (current.currentPeriodEnd > now) return 'not_due';

      const priceField = PRICE_OF[tenant.billingModel];
      const price = priceField ? current.package[priceField] : null;
      // `package_price_in_use` refuses clearing a price a subscriber's period uses, so this is a broken row, not a business case.
      if (!price) throw new Error(`tenant ${tenantId}'s package has no price for ${tenant.billingModel}`);

      const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId }, select: { cachedBalance: true } });
      const balance = wallet?.cachedBalance ?? new Prisma.Decimal(0);
      const unpaidSuspension = tenant.status === TenantStatus.suspended && tenant.suspensionCause === TenantSuspensionCause.non_payment;

      if (balance.gte(price)) {
        await this.ledger.debit(tx, {
          tenantId,
          amount: price,
          reasonType: TenantBillingReasonType.subscription_charge,
          referenceId: periodChargeReference(tenantId, current.currentPeriodEnd),
        });
        let next = addBillingPeriod(unpaidSuspension ? now : current.currentPeriodEnd, tenant.billingModel);
        // A sweep that did not run for a whole period does not charge the missed ones back to back.
        if (next <= now) next = addBillingPeriod(now, tenant.billingModel);
        await tx.tenantSubscription.update({ where: { tenantId }, data: { currentPeriodEnd: next, renewalWarnedAt: null, graceUntil: null } });
        await replacePackageEntitlements(tx, [tenantId], current.package.includedFeatureKeys as string[]);
        if (tenant.status === TenantStatus.trial || unpaidSuspension) {
          await applyTenantStatus(tx, tenantId, { from: tenant.status, to: TenantStatus.active, reason: 'subscription_renewed', actorUserId: null, now });
        }
        return 'renewed';
      }

      if (tenant.status === TenantStatus.suspended) return 'waiting';
      const suspendsAt = renewalDeadline(current.currentPeriodEnd, settings.renewalGraceDays, current.graceUntil);
      const notice = { tenantId, ownerUserId: tenant.ownerUserId, amount: price.toFixed(2), balance: balance.toFixed(2) };

      if (now >= suspendsAt) {
        await applyTenantStatus(tx, tenantId, {
          from: tenant.status,
          to: TenantStatus.suspended,
          reason: 'subscription_unpaid',
          actorUserId: null,
          cause: TenantSuspensionCause.non_payment,
          holdDays: settings.suspensionHoldDays,
          now,
        });
        await this.announce(tx, tenantId, OutboxEventType.TENANT_SUBSCRIPTION_SUSPENDED, notice);
        return 'suspended';
      }

      if (current.renewalWarnedAt && now.getTime() - current.renewalWarnedAt.getTime() < DAY_MS) return 'waiting';
      await tx.tenantSubscription.update({ where: { tenantId }, data: { renewalWarnedAt: now } });
      await this.announce(tx, tenantId, OutboxEventType.TENANT_SUBSCRIPTION_PAYMENT_DUE, { ...notice, suspendsAt: suspendsAt.toISOString() });
      return 'warned';
    });

    if (outcome === 'renewed' || outcome === 'suspended') this.logger.log(`reseller ${tenantId} renewal: ${outcome}`);
    return outcome;
  }

  private async announce(tx: Prisma.TransactionClient, tenantId: string, type: OutboxEventType, payload: Record<string, string>): Promise<void> {
    await tx.outboxEvent.create({
      data: { aggregate: 'tenant.subscription', aggregateId: tenantId, type, payload },
      select: { id: true },
    });
  }
}
