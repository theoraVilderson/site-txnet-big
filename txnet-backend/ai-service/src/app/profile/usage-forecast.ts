import { Prisma } from '@prisma/client';
import { FORECAST_AHEAD_DAYS, FORECAST_RATE_DAYS, forecastSpanMs, moneyText } from '@txnet-backend/shared-core';

import type { PredictionRow } from './predictions';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** One UTC day of a reseller's wholesale spend (`metered_usage_charge` debits, `metered_usage_refund` credits). */
export type SpendDay = { day: Date; charged: Prisma.Decimal; refunded: Prisma.Decimal; currencyCode: string };

export type WalletRunOut = {
  perDay: Prisma.Decimal;
  observedDays: number;
  runsOutAt: Date;
  /** What brings the wallet to 30 days of spend, rounded up to a whole unit; 0 when it already holds them. */
  topUp: Prisma.Decimal;
  balance: Prisma.Decimal;
  currencyCode: string;
};

/**
 * A reseller's billing wallet at its wholesale rate (F-1525-a): the net spend
 * of the last 7 days — refunds back out, another currency never added (C-02) —
 * per day, the instant the balance reaches zero at that rate, and the top-up
 * that holds 30 days of it. `null` from under a day of history or no net
 * spend. A forecast only: nothing here moves money (§24.3).
 */
export function walletRunOut(
  input: { balance: Prisma.Decimal; currencyCode: string; spend: SpendDay[]; firstChargeAt: Date | null },
  now: Date,
): WalletRunOut | null {
  if (!input.firstChargeAt) return null;
  const observedMs = forecastSpanMs(input.firstChargeAt.getTime(), now.getTime());
  if (observedMs === null) return null;
  const since = now.getTime() - FORECAST_RATE_DAYS * DAY_MS;
  const net = input.spend
    .filter((d) => d.currencyCode === input.currencyCode && d.day.getTime() >= since && d.day.getTime() <= now.getTime())
    .reduce((sum, d) => sum.plus(d.charged).minus(d.refunded), new Prisma.Decimal(0));
  if (net.lte(0)) return null;
  const observedDays = observedMs / DAY_MS;
  const perDay = net.div(observedDays);
  const left = Prisma.Decimal.max(input.balance, 0);
  const runsOutAt = new Date(now.getTime() + Math.round(left.div(perDay).toNumber() * DAY_MS));
  const topUp = Prisma.Decimal.max(perDay.times(FORECAST_AHEAD_DAYS).minus(input.balance).ceil(), 0);
  return { perDay, observedDays: Math.round(observedDays * 100) / 100, runsOutAt, topUp, balance: input.balance, currencyCode: input.currencyCode };
}

/**
 * A reseller's `wallet_need` (subject `tenant`, in the platform's tenant): the
 * top-up, in the wallet's currency, dated at the run-out — only when that is
 * inside 30 days.
 */
export function walletNeedPrediction(r: WalletRunOut, now: Date): PredictionRow | null {
  if (r.runsOutAt.getTime() > now.getTime() + FORECAST_AHEAD_DAYS * DAY_MS) return null;
  return {
    kind: 'wallet_need',
    value: r.topUp,
    predictedAt: r.runsOutAt,
    currencyCode: r.currencyCode,
    confidence: Number((0.5 + 0.4 * Math.min(1, r.observedDays / FORECAST_RATE_DAYS)).toFixed(4)),
    reasons: [{ code: 'wholesale_rate', perDay: moneyText(r.perDay), observedDays: r.observedDays, balance: moneyText(r.balance), currencyCode: r.currencyCode }],
  };
}

export type MeterForecast = { meterKey: string; last7d: string; perDay: string; next30d: string; observedHours: number };

/**
 * A tenant's total use per meter (F-1525-a), from `ai.meter_reading`: the last
 * 7 days, a day's mean over the history it has (from 24 h up) and 30 days of
 * it. Units are the meter's own — never summed across two — as decimal
 * strings, whole units rounded down.
 */
export function usageForecast(rows: Array<{ meterKey: string; hour: Date; delta: bigint }>, now: Date): MeterForecast[] {
  const since = now.getTime() - FORECAST_RATE_DAYS * DAY_MS;
  const meters = new Map<string, { first: number; last7d: bigint }>();
  for (const r of rows) {
    const m = meters.get(r.meterKey) ?? { first: r.hour.getTime(), last7d: BigInt(0) };
    m.first = Math.min(m.first, r.hour.getTime());
    if (r.hour.getTime() >= since && r.hour.getTime() <= now.getTime()) m.last7d += r.delta;
    meters.set(r.meterKey, m);
  }
  const out: MeterForecast[] = [];
  for (const [meterKey, m] of [...meters].sort(([a], [b]) => a.localeCompare(b))) {
    const span = forecastSpanMs(m.first, now.getTime());
    if (span === null) continue;
    const observedHours = Math.floor(span / HOUR_MS);
    const hours = BigInt(observedHours);
    out.push({
      meterKey,
      last7d: m.last7d.toString(),
      perDay: ((m.last7d * BigInt(24)) / hours).toString(),
      next30d: ((m.last7d * BigInt(24 * FORECAST_AHEAD_DAYS)) / hours).toString(),
      observedHours,
    });
  }
  return out;
}
