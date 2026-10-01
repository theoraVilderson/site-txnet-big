import { randomUUID } from 'node:crypto';

import { Prisma, TenantBillingReasonType, type ResellerQuotaUsage } from '@prisma/client';

import { RESELLER_LIMITS, resellerLimitOf, resellerOverageOf, type QuotaOverageTerms, type ResellerQuotaKey } from '../tenant/reseller-limits';
import { TenantBillingInsufficientBalance, TenantBillingLedger } from '../tenant/billing/tenant-billing-ledger';
import { platformCurrencyOf } from './operating-currency';
import { DEFAULT_QUOTA_TIME_ZONE, isTimeZone, quotaPeriodAt, type QuotaPeriod, type QuotaPeriodKind } from './quota-period';

/**
 * The quota engine (ADR-0107 point 4, F-019-v2): what a reseller's package
 * sells, counted and — past what it includes — sold or refused, with one call
 * at the act and one to give it back.
 *
 *   consume(tx, {tenantId, meter, qty, sourceRef})  — at the act, in its transaction
 *   release(tx, {tenantId, sourceRef})              — when the act is cancelled or refunded
 *
 * A new limited thing (tickets, AI requests) is a `kind: 'quota'` line in
 * `RESELLER_LIMITS` with its `period`, plus one `consume` where it happens. No
 * table and no new code path: everything below is per meter.
 *
 * - **One row per act.** `reseller_quota_usage` is unique on (tenant, meter,
 *   sourceRef). Consuming the same act again answers the row it wrote and
 *   charges nothing more, so a retried request is harmless.
 * - **Fixed periods** (point 7, `quota-period.ts`). The included units of
 *   live rows created in the period are what is used. A released row gives
 *   its units back.
 * - **Prepaid overage** (point 5). Units past what is included are debited
 *   from the reseller's billing wallet (`quota_overage_charge`, reference =
 *   the usage row) in the caller's transaction. No invoice, no debt.
 * - **Stop** (points 2, 5, 6). A `stop` key, an empty wallet, the reseller's
 *   own monthly spend cap, or a price not in the wallet's currency refuses
 *   the **whole** act with `ResellerQuotaExhausted`, before anything is
 *   written. A caller never gets half its units.
 * - **Release gives back** (point 10). Each live row of the act is marked
 *   released and its charge credited back (`quota_overage_refund`, same
 *   reference). Once only.
 * - **Locks.** A per-(tenant, meter) transaction advisory lock, so two acts
 *   cannot both see the last included unit. Then, only to charge against a
 *   spend cap, a per-tenant one. A caller consuming several meters in one
 *   transaction does so in meter order.
 *
 * The platform's own tenant, and anything not a reseller, is exempt: nothing
 * is counted or written. Money is `Decimal` (C-02, point 12).
 */

/** Why an act was refused past its quota. The buyer is told only "not available now" (point 11). */
export type QuotaStopReason = 'stop' | 'wallet_empty' | 'spend_cap' | 'price_unavailable';

/** Everything the engine needs to know about one meter for one reseller. A product meter (F-019-v6) brings its own. */
export type QuotaMeterTerms = {
  meter: string;
  period: QuotaPeriodKind;
  /** Units included per period; `null` = no limit (counted, never sold past). */
  included: number | null;
  overage: QuotaOverageTerms;
};

export type QuotaConsumption =
  | { exempt: true }
  | {
      exempt: false;
      usageId: string;
      meter: string;
      qty: number;
      includedQty: number;
      overageQty: number;
      /** What the overage cost, in `currencyCode`; `"0.00"` and null with none. */
      overageAmount: Prisma.Decimal;
      currencyCode: string | null;
      period: QuotaPeriod;
      /** `true`: this act had already consumed; the row is the first call's, nothing new was written. */
      replay: boolean;
    };

/** The act is refused past its quota; nothing was written. Flat facts, no text (`sanitizeError`). */
export class ResellerQuotaExhausted extends Error {
  readonly reason = 'reseller_quota_exhausted' as const;

  constructor(
    readonly meter: string,
    readonly stoppedBy: QuotaStopReason,
    readonly included: number,
    readonly used: number,
  ) {
    super(`reseller quota exhausted: ${meter} (${used} of ${included} included; ${stoppedBy})`);
    this.name = 'ResellerQuotaExhausted';
  }

  get facts(): { meter: string; stoppedBy: QuotaStopReason; included: number; used: number } {
    return { meter: this.meter, stoppedBy: this.stoppedBy, included: this.included, used: this.used };
  }
}

/** The act was given back already: a sourceRef consumes once. A new attempt is a new act with its own reference. */
export class ResellerQuotaSourceReleased extends Error {
  constructor(
    readonly meter: string,
    readonly sourceRef: string,
  ) {
    super(`quota ${meter}: ${sourceRef} was released; a new act needs a new sourceRef`);
    this.name = 'ResellerQuotaSourceReleased';
  }
}

const ledger = new TenantBillingLedger();
const SETTINGS_ID = 1;

/** A registry quota key's terms for one reseller: its number and overage, each at its own most specific level. `null` = exempt. */
export async function quotaTermsOf(tx: Prisma.TransactionClient, tenantId: string, key: ResellerQuotaKey): Promise<QuotaMeterTerms | null> {
  const [limit, overage] = await Promise.all([resellerLimitOf(tx, tenantId, key), resellerOverageOf(tx, tenantId, key)]);
  if (limit.source === 'exempt') return null;
  return { meter: key, period: RESELLER_LIMITS[key].period, included: limit.limit, overage };
}

/** Consumes `qty` units of a registry quota key for this act. */
async function consume(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; meter: ResellerQuotaKey; qty: number; sourceRef: string; now?: Date },
): Promise<QuotaConsumption> {
  const terms = await quotaTermsOf(tx, input.tenantId, input.meter);
  if (!terms) return { exempt: true };
  return consumeMeter(tx, { ...input, terms });
}

/** Consumes against terms the caller resolved; the registry path above is one caller of it. */
async function consumeMeter(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; terms: QuotaMeterTerms; qty: number; sourceRef: string; now?: Date },
): Promise<QuotaConsumption> {
  const { tenantId, terms, qty, sourceRef } = input;
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`quota ${terms.meter}: qty must be a whole number above zero, got ${qty}`);
  const now = input.now ?? new Date();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_quota:${tenantId}:${terms.meter}`}))`;

  const existing = await tx.resellerQuotaUsage.findUnique({ where: { tenantId_meter_sourceRef: { tenantId, meter: terms.meter, sourceRef } } });
  if (existing) {
    if (existing.releasedAt) throw new ResellerQuotaSourceReleased(terms.meter, sourceRef);
    return consumption(existing, terms.period, true);
  }

  const clock = await clockOf(tx, tenantId);
  const period = quotaPeriodAt(terms.period, now, clock.zone, clock.subscriptionEnd);
  let includedQty = qty;
  let used = 0;
  if (terms.included !== null) {
    used = await includedUsed(tx, tenantId, terms.meter, period);
    includedQty = Math.min(qty, Math.max(0, terms.included - used));
  }
  const overageQty = qty - includedQty;
  const id = randomUUID();
  let charge: { unitPrice: Prisma.Decimal; amount: Prisma.Decimal; currencyCode: string; transactionId: string } | null = null;

  if (overageQty > 0) {
    const included = terms.included ?? 0;
    const stop = (why: QuotaStopReason) => new ResellerQuotaExhausted(terms.meter, why, included, used);
    if (terms.overage.mode === 'stop') throw stop('stop');
    const { unitPrice, currencyCode } = terms.overage;
    // The wallet is in the platform's money; a price left in another (a change not converted) is not guessed at.
    if (currencyCode !== (await platformCurrencyOf(tx))) throw stop('price_unavailable');
    const amount = unitPrice.mul(overageQty);
    if (!(await underSpendCap(tx, tenantId, amount, currencyCode, now, clock))) throw stop('spend_cap');
    try {
      const moved = await ledger.debit(tx, { tenantId, amount, currencyCode, reasonType: TenantBillingReasonType.quota_overage_charge, referenceId: id });
      charge = { unitPrice, amount, currencyCode, transactionId: moved.id };
    } catch (e) {
      // Thrown before the ledger wrote anything, so the caller's transaction is still whole.
      if (e instanceof TenantBillingInsufficientBalance) throw stop('wallet_empty');
      throw e;
    }
  }

  const row = await tx.resellerQuotaUsage.create({
    data: {
      id,
      tenantId,
      meter: terms.meter,
      sourceRef,
      periodStart: period.start,
      periodEnd: period.end,
      qty,
      includedQty,
      overageQty,
      unitPrice: charge?.unitPrice ?? null,
      overageAmount: charge?.amount ?? new Prisma.Decimal(0),
      currencyCode: charge?.currencyCode ?? null,
      chargeTransactionId: charge?.transactionId ?? null,
      createdAt: now,
    },
  });
  return consumption(row, terms.period, false);
}

/**
 * Gives back every live row of one act: its included units return to their
 * period, its overage charge to the wallet. Releasing what is already released,
 * or what never consumed, gives back nothing.
 */
async function release(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; sourceRef: string; now?: Date },
): Promise<{ released: number; refunded: Array<{ amount: Prisma.Decimal; currencyCode: string }> }> {
  const { tenantId, sourceRef } = input;
  const now = input.now ?? new Date();
  const rows = await tx.resellerQuotaUsage.findMany({ where: { tenantId, sourceRef, releasedAt: null }, orderBy: { meter: 'asc' } });
  const refunded: Array<{ amount: Prisma.Decimal; currencyCode: string }> = [];
  let released = 0;
  for (const row of rows) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_quota:${tenantId}:${row.meter}`}))`;
    const { count } = await tx.resellerQuotaUsage.updateMany({ where: { id: row.id, releasedAt: null }, data: { releasedAt: now } });
    if (count !== 1) continue;
    released++;
    if (row.overageAmount.gt(0) && row.currencyCode) {
      // In the currency it was charged in; a platform change since is converted by the ledger.
      const moved = await ledger.credit(tx, {
        tenantId,
        amount: row.overageAmount,
        currencyCode: row.currencyCode,
        reasonType: TenantBillingReasonType.quota_overage_refund,
        referenceId: row.id,
      });
      await tx.resellerQuotaUsage.update({ where: { id: row.id }, data: { refundTransactionId: moved.id } });
      refunded.push({ amount: row.overageAmount, currencyCode: row.currencyCode });
    }
  }
  return { released, refunded };
}

/** One meter's statement for one reseller: "1000 included, 43 extra this week", and what overage cost this month. */
export type QuotaStatement = {
  meter: string;
  period: QuotaPeriod;
  included: number | null;
  includedUsed: number;
  overageQty: number;
  overageAmount: string;
  overage: { mode: QuotaOverageTerms['mode']; unitPrice: string | null; currencyCode: string | null };
  spend: QuotaSpend;
};

async function statementOf(tx: Prisma.TransactionClient, tenantId: string, key: ResellerQuotaKey, now = new Date()): Promise<QuotaStatement | null> {
  const terms = await quotaTermsOf(tx, tenantId, key);
  if (!terms) return null;
  const clock = await clockOf(tx, tenantId);
  const period = quotaPeriodAt(terms.period, now, clock.zone, clock.subscriptionEnd);
  const sums = await tx.resellerQuotaUsage.aggregate({
    where: { tenantId, meter: terms.meter, releasedAt: null, createdAt: { gte: period.start, lt: period.end } },
    _sum: { includedQty: true, overageQty: true, overageAmount: true },
  });
  return {
    meter: terms.meter,
    period,
    included: terms.included,
    includedUsed: sums._sum.includedQty ?? 0,
    overageQty: sums._sum.overageQty ?? 0,
    overageAmount: (sums._sum.overageAmount ?? new Prisma.Decimal(0)).toFixed(2),
    overage: { mode: terms.overage.mode, unitPrice: terms.overage.unitPrice?.toFixed(2) ?? null, currencyCode: terms.overage.currencyCode },
    spend: await spendOf(tx, tenantId, now, clock),
  };
}

/** What overage cost the reseller this subscription month, against its own cap (point 6); `cap` null = none. */
export type QuotaSpend = { month: QuotaPeriod; cap: string | null; spent: string; currencyCode: string };

async function spendOf(tx: Prisma.TransactionClient, tenantId: string, now = new Date(), known?: Clock): Promise<QuotaSpend> {
  const clock = known ?? (await clockOf(tx, tenantId));
  const currencyCode = await platformCurrencyOf(tx);
  const cap = await tx.resellerOverageCap.findUnique({ where: { tenantId }, select: { amount: true } });
  return {
    month: quotaPeriodAt('month', now, clock.zone, clock.subscriptionEnd),
    cap: cap?.amount.toFixed(2) ?? null,
    spent: (await spentThisMonth(tx, tenantId, currencyCode, now, clock)).toFixed(2),
    currencyCode,
  };
}

export const ResellerQuota = { consume, consumeMeter, release, statementOf, spendOf: (tx: Prisma.TransactionClient, tenantId: string, now?: Date) => spendOf(tx, tenantId, now) };

type Clock = { zone: string; subscriptionEnd: Date | null };

async function clockOf(tx: Prisma.TransactionClient, tenantId: string): Promise<Clock> {
  const [setting, sub] = await Promise.all([
    tx.tenantSubscriptionSetting.findUnique({ where: { id: SETTINGS_ID }, select: { quotaTimeZone: true } }),
    tx.tenantSubscription.findUnique({ where: { tenantId }, select: { currentPeriodEnd: true } }),
  ]);
  const zone = setting && isTimeZone(setting.quotaTimeZone) ? setting.quotaTimeZone : DEFAULT_QUOTA_TIME_ZONE;
  return { zone, subscriptionEnd: sub?.currentPeriodEnd ?? null };
}

async function includedUsed(tx: Prisma.TransactionClient, tenantId: string, meter: string, period: QuotaPeriod): Promise<number> {
  const sums = await tx.resellerQuotaUsage.aggregate({
    where: { tenantId, meter, releasedAt: null, createdAt: { gte: period.start, lt: period.end } },
    _sum: { includedQty: true },
  });
  return sums._sum.includedQty ?? 0;
}

/** Overage live this subscription month, in `currencyCode` — rows charged in an earlier currency are not added to a later one. */
async function spentThisMonth(tx: Prisma.TransactionClient, tenantId: string, currencyCode: string, now: Date, clock: Clock): Promise<Prisma.Decimal> {
  const month = quotaPeriodAt('month', now, clock.zone, clock.subscriptionEnd);
  const sums = await tx.resellerQuotaUsage.aggregate({
    where: { tenantId, releasedAt: null, currencyCode, createdAt: { gte: month.start, lt: month.end } },
    _sum: { overageAmount: true },
  });
  return sums._sum.overageAmount ?? new Prisma.Decimal(0);
}

/** The reseller's own ceiling (point 6): no row is no cap; a cap in another currency than the charge refuses rather than compares. */
async function underSpendCap(tx: Prisma.TransactionClient, tenantId: string, amount: Prisma.Decimal, currencyCode: string, now: Date, clock: Clock): Promise<boolean> {
  const cap = await tx.resellerOverageCap.findUnique({ where: { tenantId }, select: { amount: true, currencyCode: true } });
  if (!cap) return true;
  if (cap.currencyCode !== currencyCode) return false;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_quota_spend:${tenantId}`}))`;
  return (await spentThisMonth(tx, tenantId, currencyCode, now, clock)).plus(amount).lte(cap.amount);
}

function consumption(row: ResellerQuotaUsage, kind: QuotaPeriodKind, replay: boolean): QuotaConsumption {
  return {
    exempt: false,
    usageId: row.id,
    meter: row.meter,
    qty: row.qty,
    includedQty: row.includedQty,
    overageQty: row.overageQty,
    overageAmount: row.overageAmount,
    currencyCode: row.currencyCode,
    period: { kind, start: row.periodStart, end: row.periodEnd },
    replay,
  };
}
