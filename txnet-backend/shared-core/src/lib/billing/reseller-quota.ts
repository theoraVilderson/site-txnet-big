import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { Prisma, TenantBillingReasonType, type ResellerQuotaUsage } from '@prisma/client';

import { isResellerLimitKey, isResellerQuotaKey, RESELLER_LIMITS, type QuotaOverageTerms, type ResellerQuotaKey } from '../tenant/reseller-limits';
import { TenantBillingInsufficientBalance, TenantBillingLedger } from '../tenant/billing/tenant-billing-ledger';
import { platformCurrencyOf } from './operating-currency';
import { alertQuotaCrossings, type QuotaRefusal, type QuotaWindowUse } from './quota-alerts';
import { quotaTermsInEffectOf } from './quota-terms-lock';
import { DEFAULT_QUOTA_TIME_ZONE, isTimeZone, quotaPeriodAt, type QuotaPeriod, type QuotaPeriodKind } from './quota-period';

/**
 * The quota engine (ADR-0107 point 4, F-019-v2): what a reseller's package
 * sells, counted and — past what it includes — sold or refused, with one call
 * at the act and one to give it back.
 *
 *   consume(tx, {tenantId, meter, qty, sourceRef})  — at the act, in its transaction
 *   release(tx, {tenantId, sourceRef})              — when the act is cancelled or refunded
 *   admit(tx, {tenantId, terms, qty})               — would it be refused now? (writes nothing)
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
 * - **Several windows, one meter** (F-019-v6, user 2026-10-01). A meter may
 *   be bounded per day, week and month at once: each window bounds the
 *   units *included* in it, the act takes the least room any window has,
 *   and a unit past any of them is sold once, at the meter's one price —
 *   never once per window. A unit sold past does not use a window's
 *   included room.
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

/** One window a meter is counted in: its fixed period and the units included per period; `null` = no limit there. */
export type QuotaWindow = { period: QuotaPeriodKind; included: number | null };

/**
 * Everything the engine needs to know about one meter for one reseller. A
 * registry key has one window; a product's sales (F-019-v6) up to three, and
 * bring their own terms. `windows` is never empty, shortest first: a usage row
 * records the first window's period.
 */
export type QuotaMeterTerms = {
  meter: string;
  windows: readonly QuotaWindow[];
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
    /** The tightest window, which a refusal's alert is told for (F-019-v8). */
    readonly window?: QuotaPeriod,
  ) {
    super(`reseller quota exhausted: ${meter} (${used} of ${included} included; ${stoppedBy})`);
    this.name = 'ResellerQuotaExhausted';
  }

  get facts(): { meter: string; stoppedBy: QuotaStopReason; included: number; used: number } {
    return { meter: this.meter, stoppedBy: this.stoppedBy, included: this.included, used: this.used };
  }

  /**
   * What a caller answers the reseller with (409), the same for every quota
   * (F-019-v4). A plain `stop` on a registry key is `reseller_limit_reached`
   * with `{key, limit, used}` — the refusal every limit already gives, which
   * the panel names. An overage that could not be paid (empty wallet, the
   * reseller's cap, a stale price) or a non-registry meter keeps its own
   * reason and says why. A buyer is never shown either (point 11).
   */
  get refusal():
    | { reason: 'reseller_limit_reached'; facts: { key: ResellerQuotaKey; limit: number; used: number } }
    | { reason: 'reseller_quota_exhausted'; facts: ResellerQuotaExhausted['facts'] } {
    if (this.stoppedBy === 'stop' && isResellerLimitKey(this.meter) && isResellerQuotaKey(this.meter)) {
      return { reason: 'reseller_limit_reached', facts: { key: this.meter, limit: this.included, used: this.used } };
    }
    return { reason: this.reason, facts: this.facts };
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
const logger = new Logger('ResellerQuota');
const SETTINGS_ID = 1;

/**
 * Where a refused act is reported (F-019-v8, `quota-alerts.ts`). Its
 * transaction rolls back, so a service that consumes quotas registers a sink
 * that writes on a connection of its own (`recordQuotaRefusal` on its
 * cross-tenant pool). None registered — a spec, a service that never
 * consumes — reports nothing. The sink is never awaited by the act and its
 * failure never reaches it: a lost record costs a digest line, not a sale.
 */
let refusalSink: ((r: QuotaRefusal) => Promise<void>) | null = null;

export function setQuotaRefusalSink(sink: ((r: QuotaRefusal) => Promise<void>) | null): void {
  refusalSink = sink;
}

function reportRefusal(e: unknown, input: { tenantId: string; qty: number; overage: QuotaOverageTerms; zone: string; now: Date }): void {
  if (!refusalSink || !(e instanceof ResellerQuotaExhausted) || !e.window) return;
  const report: QuotaRefusal = {
    tenantId: input.tenantId,
    meter: e.meter,
    qty: input.qty,
    stoppedBy: e.stoppedBy,
    included: e.included,
    window: e.window,
    overage: input.overage,
    zone: input.zone,
    at: input.now,
  };
  void refusalSink(report).catch((err: unknown) => logger.error(`quota refusal of ${e.meter} for ${input.tenantId} not recorded: ${(err as Error).message}`));
}

/**
 * A registry quota key's terms for one reseller: its number and overage, each
 * at its own most specific level, held for the subscription period it paid
 * for (`quota-terms-lock.ts`, F-019-v3). `null` = exempt.
 */
export async function quotaTermsOf(tx: Prisma.TransactionClient, tenantId: string, key: ResellerQuotaKey): Promise<QuotaMeterTerms | null> {
  const terms = await quotaTermsInEffectOf(tx, tenantId, key);
  if (!terms) return null;
  return { meter: key, windows: [{ period: RESELLER_LIMITS[key].period, included: terms.included }], overage: terms.overage };
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

/** One act's split, decided under the meter's lock; nothing is written yet. */
type Plan = {
  period: QuotaPeriod;
  /** Every window before the act, for its alerts (F-019-v8). */
  windows: QuotaWindowUse[];
  includedQty: number;
  overageQty: number;
  /** What the overage would cost, with its price; null with none. */
  charge: { unitPrice: Prisma.Decimal; amount: Prisma.Decimal; currencyCode: string } | null;
  /** The window with the least room, for a refusal's figures. */
  stop: (why: QuotaStopReason) => ResellerQuotaExhausted;
};

/**
 * Splits `qty` into what the windows still include and what is sold past them,
 * and refuses what cannot be sold (`stop`, a stale price, the spend cap) —
 * everything `consumeMeter` decides before its first write. The caller holds
 * the meter's lock.
 */
async function plan(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; terms: QuotaMeterTerms; qty: number; now: Date },
  clock: Clock,
): Promise<Plan> {
  const { tenantId, terms, qty, now } = input;
  if (!Number.isInteger(qty) || qty <= 0) throw new Error(`quota ${terms.meter}: qty must be a whole number above zero, got ${qty}`);
  if (terms.windows.length === 0) throw new Error(`quota ${terms.meter}: no window`);
  const windows = await Promise.all(
    terms.windows.map(async (w) => {
      const period = quotaPeriodAt(w.period, now, clock.zone, clock.subscriptionEnd);
      const used = w.included === null ? 0 : await includedUsed(tx, tenantId, terms.meter, period);
      return { included: w.included, period, used, room: w.included === null ? Infinity : Math.max(0, w.included - used) };
    }),
  );
  // The tightest window decides; a unit past it is past the act's quota, whatever the others still include.
  const binding = windows.reduce((a, b) => (b.room < a.room ? b : a));
  const includedQty = Math.min(qty, binding.room);
  const overageQty = qty - includedQty;
  const stop = (why: QuotaStopReason) => new ResellerQuotaExhausted(terms.meter, why, binding.included ?? 0, binding.used, binding.period);
  const uses = windows.map(({ period, included, used }) => ({ period, included, used }));
  if (overageQty === 0) return { period: windows[0].period, windows: uses, includedQty, overageQty, charge: null, stop };

  if (terms.overage.mode === 'stop') throw stop('stop');
  const { unitPrice, currencyCode } = terms.overage;
  // The wallet is in the platform's money; a price left in another (a change not converted) is not guessed at.
  if (currencyCode !== (await platformCurrencyOf(tx))) throw stop('price_unavailable');
  const amount = unitPrice.mul(overageQty);
  if (!(await underSpendCap(tx, tenantId, amount, currencyCode, now, clock))) throw stop('spend_cap');
  return { period: windows[0].period, windows: uses, includedQty, overageQty, charge: { unitPrice, amount, currencyCode }, stop };
}

/** Consumes against terms the caller resolved; the registry path above is one caller of it. */
async function consumeMeter(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; terms: QuotaMeterTerms; qty: number; sourceRef: string; now?: Date },
): Promise<QuotaConsumption> {
  const { tenantId, terms, qty, sourceRef } = input;
  const now = input.now ?? new Date();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_quota:${tenantId}:${terms.meter}`}))`;

  const existing = await tx.resellerQuotaUsage.findUnique({ where: { tenantId_meter_sourceRef: { tenantId, meter: terms.meter, sourceRef } } });
  if (existing) {
    if (existing.releasedAt) throw new ResellerQuotaSourceReleased(terms.meter, sourceRef);
    return consumption(existing, terms.windows[0].period, true);
  }

  const clock = await clockOf(tx, tenantId);
  const refused = { tenantId, qty, overage: terms.overage, zone: clock.zone, now };
  let planned: Plan;
  try {
    planned = await plan(tx, { tenantId, terms, qty, now }, clock);
  } catch (e) {
    reportRefusal(e, refused);
    throw e;
  }
  const { period, includedQty, overageQty, charge: priced, stop } = planned;
  const id = randomUUID();
  let charge: { unitPrice: Prisma.Decimal; amount: Prisma.Decimal; currencyCode: string; transactionId: string } | null = null;

  if (priced) {
    try {
      const moved = await ledger.debit(tx, { tenantId, amount: priced.amount, currencyCode: priced.currencyCode, reasonType: TenantBillingReasonType.quota_overage_charge, referenceId: id });
      charge = { ...priced, transactionId: moved.id };
    } catch (e) {
      // Thrown before the ledger wrote anything, so the caller's transaction is still whole.
      if (e instanceof TenantBillingInsufficientBalance) {
        const empty = stop('wallet_empty');
        reportRefusal(empty, refused);
        throw empty;
      }
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
  // 80% and 100%, told once each, committed with the act (F-019-v8).
  await alertQuotaCrossings(tx, { tenantId, meter: terms.meter, windows: planned.windows, includedQty, overageQty, overage: terms.overage });
  return consumption(row, terms.windows[0].period, false);
}

/**
 * Would `qty` more units be refused now? Throws the `ResellerQuotaExhausted`
 * that `consumeMeter` would — `wallet_empty` included, read from the balance —
 * and writes nothing. For a check before the act exists (an invoice, F-019-v6),
 * which the act's own `consumeMeter` repeats under the same lock.
 */
async function admit(tx: Prisma.TransactionClient, input: { tenantId: string; terms: QuotaMeterTerms; qty: number; now?: Date }): Promise<void> {
  const now = input.now ?? new Date();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_quota:${input.tenantId}:${input.terms.meter}`}))`;
  const clock = await clockOf(tx, input.tenantId);
  try {
    const { charge, stop } = await plan(tx, { ...input, now }, clock);
    if (!charge) return;
    const wallet = await tx.tenantBillingWallet.findUnique({ where: { tenantId: input.tenantId }, select: { cachedBalance: true, currencyCode: true } });
    if (!wallet || wallet.currencyCode !== charge.currencyCode || wallet.cachedBalance.lt(charge.amount)) throw stop('wallet_empty');
  } catch (e) {
    // A buyer refused at the invoice is a refused act too (F-019-v8).
    reportRefusal(e, { tenantId: input.tenantId, qty: input.qty, overage: input.terms.overage, zone: clock.zone, now });
    throw e;
  }
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
  const [window] = terms.windows;
  const clock = await clockOf(tx, tenantId);
  const period = quotaPeriodAt(window.period, now, clock.zone, clock.subscriptionEnd);
  const sums = await tx.resellerQuotaUsage.aggregate({
    where: { tenantId, meter: terms.meter, releasedAt: null, createdAt: { gte: period.start, lt: period.end } },
    _sum: { includedQty: true, overageQty: true, overageAmount: true },
  });
  return {
    meter: terms.meter,
    period,
    included: window.included,
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

export const ResellerQuota = { consume, consumeMeter, admit, release, statementOf, spendOf: (tx: Prisma.TransactionClient, tenantId: string, now?: Date) => spendOf(tx, tenantId, now) };

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
