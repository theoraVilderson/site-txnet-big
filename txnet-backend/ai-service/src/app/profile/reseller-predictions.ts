import { Prisma } from '@prisma/client';

import type { PredictionRow, Reason } from './predictions';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The rate is the last 7 days' units; a reseller younger than that is read over its own history. */
export const QUOTA_RATE_WINDOW_MS = 7 * DAY_MS;
/** Under a day of history is no rate at all. */
export const QUOTA_MIN_OBSERVED_MS = DAY_MS;
/** A wallet short of the renewal counts only this close to it. */
export const CHURN_WALLET_HORIZON_DAYS = 14;
/** Sales "fell" or "grew" only against a previous 30 days of at least this many. */
export const CHURN_MIN_PREVIOUS_SALES = 10;
/** At most this many windows are named in a prediction's reasons. */
const MAX_QUOTA_REASONS = 20;

/** One window of one quota meter, as the quota engine states it now (billing contract.reseller-quota.md). */
export type QuotaWindowInput = {
  meter: string;
  period: 'day' | 'week' | 'month';
  start: Date;
  end: Date;
  /** null: no limit — never runs out. */
  included: number | null;
  includedUsed: number;
  overageQty: number;
  mode: 'stop' | 'overage';
};

/** A reseller seen by the platform's run (F-038-o1). Every count is of live (unreleased) usage rows. */
export type ResellerInputs = {
  tenantId: string;
  windows: QuotaWindowInput[];
  /** Per meter: units consumed in the last 7 days, and the meter's first row in the read range. */
  usage: Array<{ meter: string; last7d: number; firstAt: Date }>;
  /** Platform products sold (`product:*` meters): the last 30 days and the 30 before. */
  sales: { last30: number; prev30: number };
  subscription: {
    currentPeriodEnd: Date;
    renewalWarnedAt: Date | null;
    graceUntil: Date | null;
    nextPackageId: string | null;
    /** The current package's price for the reseller's period; null when the package has none for it. */
    renewalPrice: Prisma.Decimal | null;
    priceCurrency: string | null;
  } | null;
  wallet: { balance: Prisma.Decimal; currencyCode: string } | null;
};

/**
 * Quota exhaustion (ADR-0109 point 7, "for a tenant, quota exhaustion per
 * ADR-0107 key"): for every window with a limit, when the included units run
 * out at the last 7 days' rate — only if that is before the window ends, since
 * a new window starts empty. A window already full is now. The soonest is the
 * prediction; every window at risk is a reason, soonest first.
 */
export function quotaExhaustion(input: ResellerInputs, now: Date): PredictionRow | null {
  const rates = new Map(input.usage.map((u) => [u.meter, u]));
  const atRisk: Array<{ at: number; confidence: number; reason: Reason }> = [];
  for (const w of input.windows) {
    if (w.included === null) continue;
    const base = { meter: w.meter, period: w.period, periodEnd: w.end.toISOString(), included: w.included, used: w.includedUsed, overageQty: w.overageQty, mode: w.mode };
    const remaining = w.included - w.includedUsed;
    if (remaining <= 0) {
      atRisk.push({ at: now.getTime(), confidence: 0.95, reason: { code: 'quota_full', ...base } });
      continue;
    }
    const u = rates.get(w.meter);
    if (!u || u.last7d <= 0) continue;
    const observedMs = Math.min(QUOTA_RATE_WINDOW_MS, now.getTime() - u.firstAt.getTime());
    if (observedMs < QUOTA_MIN_OBSERVED_MS) continue;
    const perMs = u.last7d / observedMs;
    const runsOut = now.getTime() + remaining / perMs;
    if (runsOut >= w.end.getTime()) continue;
    atRisk.push({
      at: runsOut,
      confidence: 0.5 + 0.4 * (observedMs / QUOTA_RATE_WINDOW_MS),
      reason: { code: 'quota_rate', ...base, perDay: Math.round(perMs * DAY_MS * 100) / 100, observedHours: Math.round(observedMs / HOUR_MS) },
    });
  }
  if (atRisk.length === 0) return null;
  atRisk.sort((a, b) => a.at - b.at);
  const [first] = atRisk;
  const days = (first.at - now.getTime()) / DAY_MS;
  return {
    kind: 'quota_exhaustion',
    value: new Prisma.Decimal(days.toFixed(4)),
    predictedAt: new Date(Math.round(first.at)),
    currencyCode: null,
    confidence: Number(first.confidence.toFixed(4)),
    reasons: atRisk.slice(0, MAX_QUOTA_REASONS).map((r) => ({ ...r.reason, at: new Date(Math.round(r.at)).toISOString() })),
  };
}

/**
 * Churn risk (point 7): weighted rules, as renewal probability is for a user,
 * until there are outcomes to calibrate on. Dated at the subscription's end —
 * the moment the reseller stays or goes.
 */
export function churnRisk(input: ResellerInputs, now: Date): PredictionRow | null {
  const sub = input.subscription;
  if (!sub) return null;
  let p = 0.15;
  const reasons: Reason[] = [{ code: 'churn_base', value: 0.15 }];

  const daysLeft = (sub.currentPeriodEnd.getTime() - now.getTime()) / DAY_MS;
  const w = input.wallet;
  if (sub.renewalPrice && w && w.currencyCode === sub.priceCurrency && daysLeft <= CHURN_WALLET_HORIZON_DAYS && w.balance.lt(sub.renewalPrice)) {
    p += 0.3;
    reasons.push({ code: 'wallet_short', balance: w.balance.toFixed(2), price: sub.renewalPrice.toFixed(2), currencyCode: w.currencyCode, daysLeft: Math.round(daysLeft * 10) / 10 });
  }
  const inGrace = sub.graceUntil !== null && sub.graceUntil.getTime() > now.getTime();
  if (sub.renewalWarnedAt !== null || inGrace) {
    p += 0.2;
    reasons.push({ code: 'renewal_unpaid', warnedAt: sub.renewalWarnedAt?.toISOString() ?? null, graceUntil: inGrace ? (sub.graceUntil as Date).toISOString() : null });
  }
  const { last30, prev30 } = input.sales;
  if (prev30 >= CHURN_MIN_PREVIOUS_SALES && last30 * 2 < prev30) {
    p += 0.2;
    reasons.push({ code: 'sales_fell', last30, prev30 });
  } else if (prev30 >= CHURN_MIN_PREVIOUS_SALES && last30 > prev30 * 1.2) {
    p -= 0.1;
    reasons.push({ code: 'sales_grew', last30, prev30 });
  }
  if (sub.nextPackageId !== null) {
    p += 0.1;
    reasons.push({ code: 'downgrade_scheduled', nextPackageId: sub.nextPackageId });
  }
  const value = Math.min(0.98, Math.max(0.02, p));
  return {
    kind: 'churn_risk',
    value: new Prisma.Decimal(value.toFixed(4)),
    predictedAt: sub.currentPeriodEnd,
    currencyCode: null,
    confidence: 0.6,
    reasons,
  };
}

export function resellerPredictions(input: ResellerInputs, now: Date): PredictionRow[] {
  return [quotaExhaustion(input, now), churnRisk(input, now)].filter((p): p is PredictionRow => p !== null);
}
