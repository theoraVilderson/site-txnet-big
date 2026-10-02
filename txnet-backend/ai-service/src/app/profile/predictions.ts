import { Prisma, type AiPredictionKind } from '@prisma/client';
import { FORECAST_MIN_OBSERVED_MS, FORECAST_WINDOW_MS, METER_KEYS } from '@txnet-backend/shared-core';

import { ACTIVE_HOURS_HALF_LIFE_DAYS, HOURS_OF_WEEK, hourOfWeek } from './active-hours';
import { utcHour } from './meter-readings';
import { grantEndedAt, type AccountInputs } from './profile-features';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** A reason is data, never prose: a `code` the template layer names, and the numbers behind it (JSON-safe). */
export type Reason = { code: string } & Record<string, string | number | boolean | null>;

export type PredictionRow = {
  kind: AiPredictionKind;
  /** A probability, a number of days, a size factor or an amount — what `kind` says. */
  value: Prisma.Decimal | null;
  predictedAt: Date | null;
  /** Set iff `value` is an amount (`wallet_need`) — C-02. */
  currencyCode: string | null;
  confidence: number;
  reasons: Reason[];
};

/** What a prediction needs beyond the account: money, read once per tenant. */
export type PredictionContext = {
  /** A variant's price in force now — the tenant's own before the platform's. */
  prices: ReadonlyMap<string, { amount: Prisma.Decimal; currencyCode: string }>;
  /** `billing.deposit_setting.presets`, or none. */
  presets: { amounts: Prisma.Decimal[]; currencyCode: string } | null;
};

/** How far ahead an exhaustion date is looked for; past it, the Grant's end or a renewal is the likelier news. */
const EXHAUSTION_HORIZON_DAYS = 90;
/** Readings must reach this far back before their hours of week mean anything; under it the rate is flat. */
const WEIGHTING_MIN_HISTORY_DAYS = 7;
/** A renewal is predicted only for a Grant ending this soon. */
const RENEWAL_HORIZON_DAYS = 30;
/** Point 7: "used under 40% of the purchase over two periods". */
const RIGHT_SIZE_DOWN_SHARE = 0.4;
/** A period "ran out" when this share of what it bought was used before its planned end. */
const RAN_OUT_SHARE = 0.98;
/** Point 7: win-back windows, days without an active Grant. */
export const WIN_BACK_WINDOWS_DAYS = [14, 30, 60] as const;
/** How long after a trial ends it still converts. */
const TRIAL_AFTERLIFE_DAYS = 14;

const clamp = (v: number, lo = 0.02, hi = 0.98) => Math.min(hi, Math.max(lo, v));
const prob = (v: number) => new Prisma.Decimal(v.toFixed(4));
const bytes = (b: bigint | number) => b.toString();
const isPrepaidBag = (g: AccountInputs['grants'][number]) => g.status === 'active' && g.billingMode === 'prepaid' && !g.trafficUnlimited;

function trafficReadings(input: AccountInputs, grantId?: string) {
  return input.readings.filter((r) => r.meterKey === METER_KEYS.vpnTraffic && (grantId === undefined || r.grantId === grantId));
}

/**
 * Hour-of-week weights from the account's use, bytes-weighted and halved every
 * 28 days, scaled so a flat week is all 1. `null` while the readings reach back
 * less than a week — a pattern is not yet visible, and the rate stays flat.
 */
function usageWeights(input: AccountInputs, now: Date): number[] | null {
  const used = trafficReadings(input).filter((r) => r.delta > BigInt(0));
  const first = input.readings.reduce<number>((a, r) => Math.min(a, r.hour.getTime()), Infinity);
  if (used.length === 0 || now.getTime() - first < WEIGHTING_MIN_HISTORY_DAYS * DAY_MS) return null;
  const w = new Array<number>(HOURS_OF_WEEK).fill(0);
  let total = 0;
  for (const r of used) {
    const decay = Math.pow(0.5, Math.max(0, now.getTime() - r.hour.getTime()) / DAY_MS / ACTIVE_HOURS_HALF_LIFE_DAYS);
    const v = Number(r.delta) * decay;
    w[hourOfWeek(r.hour)] += v;
    total += v;
  }
  return w.map((x) => (x / total) * HOURS_OF_WEEK);
}

/**
 * Meter exhaustion (point 7): F-602's rate — the growth of the last 72 h, at
 * least 24 h of it observed — from `ai.meter_reading`, since the engine reads
 * no traffic log. A reading keyed at hour H holds the growth up to H, so the
 * window is the 72 hour-keys before the current hour. With a week of history
 * the rate is spread over the hours of week the account spends in; then the
 * bytes left are walked forward hour by hour. Only a prepaid bag, only when it
 * runs out before the Grant ends; of several, the soonest.
 */
export function meterExhaustion(input: AccountInputs, now: Date): PredictionRow | null {
  const anchor = utcHour(now).getTime();
  const weights = usageWeights(input, now);
  const weight = (at: number) => (weights ? weights[hourOfWeek(new Date(at))] : 1);
  let best: PredictionRow | null = null;

  for (const g of input.grants.filter(isPrepaidBag)) {
    const remaining = Number(g.purchasedBytes - g.consumedBytes);
    if (remaining <= 0) continue;
    const from = anchor - FORECAST_WINDOW_MS;
    const ranSince = (g.activatedAt ?? g.startsAt).getTime();
    const observedMs = anchor - Math.max(from, ranSince);
    if (observedMs < FORECAST_MIN_OBSERVED_MS) continue;
    const windowBytes = trafficReadings(input, g.id)
      .filter((r) => r.hour.getTime() >= from && r.hour.getTime() < anchor && r.hour.getTime() > ranSince - HOUR_MS)
      .reduce((a, r) => a + Number(r.delta), 0);
    if (windowBytes <= 0) continue;

    // Bytes per hour at weight 1, normalised by the weights the window itself had.
    let windowWeight = 0;
    for (let t = anchor - observedMs; t < anchor; t += HOUR_MS) windowWeight += weight(t);
    if (windowWeight <= 0) continue;
    const perWeight = windowBytes / windowWeight;

    const limit = Math.min(now.getTime() + EXHAUSTION_HORIZON_DAYS * DAY_MS, g.endsAt?.getTime() ?? Infinity);
    let left = remaining;
    let t = now.getTime();
    let at: number | null = null;
    while (t < limit) {
      const hourEnd = utcHour(new Date(t)).getTime() + HOUR_MS;
      const spend = (perWeight * weight(t) * (hourEnd - t)) / HOUR_MS;
      if (spend >= left) {
        at = t + ((hourEnd - t) * left) / spend;
        break;
      }
      left -= spend;
      t = hourEnd;
    }
    if (at === null || at >= limit) continue;

    const days = (at - now.getTime()) / DAY_MS;
    if (best?.value && best.value.lte(days)) continue;
    best = {
      kind: 'meter_exhaustion',
      value: new Prisma.Decimal(days.toFixed(4)),
      predictedAt: new Date(at),
      currencyCode: null,
      confidence: Number((0.5 + 0.4 * Math.min(1, observedMs / FORECAST_WINDOW_MS) - (weights ? 0 : 0.05)).toFixed(4)),
      reasons: [
        { code: 'recent_rate', grantId: g.id, meterKey: METER_KEYS.vpnTraffic, bytesPerDay: bytes(Math.round((windowBytes / observedMs) * DAY_MS)), observedHours: Math.round(observedMs / HOUR_MS) },
        { code: 'remaining', grantId: g.id, bytes: bytes(remaining) },
        { code: weights ? 'weighted_by_hour_of_week' : 'flat_rate' },
      ],
    };
  }
  return best;
}

/**
 * Renewal probability (point 7): weighted rules from 0.5 until the tenant has
 * 200 outcomes to calibrate on (a later row). For the paid Grant ending
 * soonest, within 30 days; a trial is trial conversion's.
 */
export function renewalProbability(input: AccountInputs, now: Date): PredictionRow | null {
  const g = input.grants
    .filter((x) => x.status === 'active' && x.source !== 'trial' && x.endsAt !== null && x.endsAt.getTime() > now.getTime() && x.endsAt.getTime() - now.getTime() <= RENEWAL_HORIZON_DAYS * DAY_MS)
    .sort((a, b) => (a.endsAt as Date).getTime() - (b.endsAt as Date).getTime())[0];
  if (!g?.endsAt) return null;

  const reasons: Reason[] = [{ code: 'rule_defaults', base: 0.5 }];
  let p = 0.5;
  const add = (delta: number, reason: Reason) => {
    p += delta;
    reasons.push({ ...reason, weight: delta });
  };

  const renewed = input.renewals.filter((r) => r.createdAt.getTime() > now.getTime() - 180 * DAY_MS).length;
  if (renewed > 0) add(0.2, { code: 'renewed_before', count: renewed });

  if (isPrepaidBag(g)) {
    const bag = Number(g.purchasedBytes - g.usagePeriodFromBytes);
    const share = bag > 0 ? Number(g.consumedBytes - g.usagePeriodFromBytes) / bag : 0;
    const start = (g.activatedAt ?? g.startsAt).getTime();
    const elapsed = (now.getTime() - start) / (g.endsAt.getTime() - start);
    if (share >= 0.5) add(0.1, { code: 'used_most_of_period', share: Number(share.toFixed(2)) });
    else if (share < 0.1 && elapsed >= 0.5) add(-0.15, { code: 'barely_used', share: Number(share.toFixed(2)) });
  }

  const usedLately = trafficReadings(input).some((r) => r.delta > BigInt(0) && r.hour.getTime() > now.getTime() - 7 * DAY_MS);
  if (!usedLately && now.getTime() - (g.activatedAt ?? g.startsAt).getTime() > 7 * DAY_MS) add(-0.2, { code: 'idle_7d' });
  if (input.signIns.some((d) => d.getTime() > now.getTime() - 7 * DAY_MS)) add(0.05, { code: 'signed_in_7d' });

  const lastSuccess = Math.max(0, ...input.payments.filter((x) => x.status === 'success').map((x) => x.createdAt.getTime()));
  if (input.payments.some((x) => x.status === 'failed' && x.createdAt.getTime() > Math.max(lastSuccess, now.getTime() - 30 * DAY_MS))) {
    add(-0.1, { code: 'payment_failed_30d' });
  }

  return {
    kind: 'renewal_probability',
    value: prob(clamp(p)),
    predictedAt: g.endsAt,
    currencyCode: null,
    confidence: renewed > 0 ? 0.7 : 0.6,
    reasons: [{ ...reasons[0], grantId: g.id }, ...reasons.slice(1)],
  };
}

/**
 * Right size (point 7): a period is one renewal to the next, of what that
 * renewal bought. Under 40 % used in each of the last two → down, `value` the
 * larger share (the size that would have fit). Ran out early in two of the
 * last three → up, `value` the mean of planned ÷ actual length of those. A
 * period the readings do not reach back to is not measured.
 */
export function rightSize(input: AccountInputs, _now: Date): PredictionRow | null {
  for (const g of input.grants.filter(isPrepaidBag)) {
    const renewals = input.renewals.filter((r) => r.grantId === g.id && r.bytes > BigInt(0)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const readings = trafficReadings(input, g.id);
    const covered = readings.reduce<number>((a, r) => Math.min(a, r.hour.getTime()), Infinity);
    const periods = renewals.slice(0, -1).flatMap((r, i) => {
      const start = r.createdAt.getTime();
      const end = renewals[i + 1].createdAt.getTime();
      if (utcHour(r.createdAt).getTime() < covered) return [];
      const used = readings.filter((x) => x.hour.getTime() > start && x.hour.getTime() <= end).reduce((a, x) => a + Number(x.delta), 0);
      const bought = Number(r.bytes);
      const planned = r.endsAtAfter ? r.endsAtAfter.getTime() - start : null;
      const ranOut = planned !== null && used >= RAN_OUT_SHARE * bought && end < start + planned;
      return [{ share: used / bought, ranOut, factor: planned !== null ? planned / (end - start) : 1, used, bought }];
    });

    const lastThree = periods.slice(-3);
    const ranOut = lastThree.filter((p) => p.ranOut);
    if (ranOut.length >= 2) {
      return {
        kind: 'right_size',
        value: new Prisma.Decimal((ranOut.reduce((a, p) => a + p.factor, 0) / ranOut.length).toFixed(4)),
        predictedAt: null,
        currencyCode: null,
        confidence: ranOut.length === 3 ? 0.75 : 0.65,
        reasons: [
          { code: 'size_up', grantId: g.id, ranOutOf: lastThree.length, ranOut: ranOut.length },
          ...ranOut.map((p) => ({ code: 'ran_out_early', usedBytes: bytes(Math.round(p.used)), boughtBytes: bytes(Math.round(p.bought)) })),
        ],
      };
    }
    const lastTwo = periods.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((p) => p.share < RIGHT_SIZE_DOWN_SHARE)) {
      return {
        kind: 'right_size',
        value: new Prisma.Decimal(Math.max(...lastTwo.map((p) => p.share)).toFixed(4)),
        predictedAt: null,
        currencyCode: null,
        confidence: 0.7,
        reasons: [
          { code: 'size_down', grantId: g.id, periods: 2, under: RIGHT_SIZE_DOWN_SHARE },
          ...lastTwo.map((p) => ({ code: 'period_share', share: Number(p.share.toFixed(4)), usedBytes: bytes(Math.round(p.used)), boughtBytes: bytes(Math.round(p.bought)) })),
        ],
      };
    }
  }
  return null;
}

/**
 * Wallet need (point 7): the next two renewals of the paid Grant ending
 * soonest, minus what the wallet has available (balance − held), rounded up to
 * the smallest deposit preset that covers it — past the largest, to its
 * multiple. Decimal throughout (C-02); never across two currencies: no price,
 * no wallet or a price in another currency is no prediction.
 */
export function walletNeed(input: AccountInputs, ctx: PredictionContext, now: Date): PredictionRow | null {
  const wallet = input.wallet;
  if (!wallet) return null;
  const g = input.grants
    .filter((x) => x.status === 'active' && x.source !== 'trial' && x.variantId !== null && ctx.prices.has(x.variantId))
    .sort((a, b) => (a.endsAt?.getTime() ?? Infinity) - (b.endsAt?.getTime() ?? Infinity))[0];
  if (!g?.variantId) return null;
  const price = ctx.prices.get(g.variantId) as { amount: Prisma.Decimal; currencyCode: string };
  if (price.currencyCode !== wallet.currencyCode) return null;

  const available = wallet.balance.minus(wallet.held);
  const need = price.amount.times(2).minus(available);
  if (need.lte(0)) return null;

  const reasons: Reason[] = [
    { code: 'next_two_renewals', grantId: g.id, variantId: g.variantId, price: price.amount.toFixed(2), currencyCode: price.currencyCode },
    { code: 'available', amount: available.toFixed(2), currencyCode: wallet.currencyCode },
  ];
  let amount = need;
  const presets = ctx.presets?.currencyCode === wallet.currencyCode ? [...ctx.presets.amounts].filter((a) => a.gt(0)).sort((a, b) => a.comparedTo(b)) : [];
  if (presets.length > 0) {
    const fits = presets.find((a) => a.gte(need));
    const largest = presets[presets.length - 1];
    amount = fits ?? need.dividedBy(largest).ceil().times(largest);
    reasons.push({ code: 'rounded_to_preset', need: need.toFixed(2), preset: (fits ?? largest).toFixed(2) });
  } else {
    reasons.push({ code: 'no_preset', need: need.toFixed(2) });
  }
  return {
    kind: 'wallet_need',
    value: new Prisma.Decimal(amount.toFixed(2)),
    predictedAt: g.endsAt && g.endsAt.getTime() > now.getTime() ? g.endsAt : null,
    currencyCode: wallet.currencyCode,
    confidence: 0.7,
    reasons,
  };
}

/**
 * Trial conversion (point 7): an account whose only Grants are trials — one
 * running, or ended within 14 days — and that never paid. Rules from 0.15.
 */
export function trialConversion(input: AccountInputs, now: Date): PredictionRow | null {
  if (input.grants.length === 0 || input.grants.some((g) => g.source !== 'trial')) return null;
  if (input.payments.some((p) => p.status === 'success')) return null;
  const live = input.grants
    .filter((g) => g.status === 'active' || grantEndedAt(g).getTime() > now.getTime() - TRIAL_AFTERLIFE_DAYS * DAY_MS)
    .sort((a, b) => (b.endsAt?.getTime() ?? 0) - (a.endsAt?.getTime() ?? 0))[0];
  if (!live) return null;

  const reasons: Reason[] = [{ code: 'trial', grantId: live.id, base: 0.15 }];
  let p = 0.15;
  const add = (delta: number, reason: Reason) => {
    p += delta;
    reasons.push({ ...reason, weight: delta });
  };
  const share = live.purchasedBytes > BigInt(0) ? Number(live.consumedBytes) / Number(live.purchasedBytes) : 0;
  if (live.consumedBytes === BigInt(0)) add(-0.1, { code: 'never_connected' });
  else {
    add(0.05, { code: 'connected' });
    if (share >= 0.3) add(0.2, { code: 'used_trial', share: Number(share.toFixed(2)) });
  }
  const days = new Set(input.signIns.map((d) => Math.floor(d.getTime() / DAY_MS)));
  if (days.size >= 2) add(0.1, { code: 'came_back', days: days.size });
  if (input.notices.some((n) => n.readAt !== null)) add(0.05, { code: 'read_a_notice' });
  if (input.walletTransactions.some((t) => t.direction === 'credit' && t.reasonType === 'payment_gateway')) add(0.3, { code: 'topped_up' });

  return {
    kind: 'trial_conversion',
    value: prob(clamp(p)),
    predictedAt: live.endsAt,
    currencyCode: null,
    confidence: 0.55,
    reasons,
  };
}

/**
 * Win-back window (point 7): an account with no active Grant that had one —
 * the next of 14 / 30 / 60 days after its last Grant ended. Past 60, none.
 */
export function winBackWindow(input: AccountInputs, now: Date): PredictionRow | null {
  if (input.grants.some((g) => g.status === 'active' || g.status === 'pending')) return null;
  const ended = input.grants.filter((g) => g.status !== 'suspended').map(grantEndedAt);
  if (ended.length === 0) return null;
  const last = Math.max(...ended.map((d) => d.getTime()));
  const window = WIN_BACK_WINDOWS_DAYS.find((d) => last + d * DAY_MS > now.getTime());
  if (window === undefined) return null;

  const signedInSince = input.signIns.some((d) => d.getTime() > last);
  return {
    kind: 'win_back_window',
    value: new Prisma.Decimal(Math.floor((now.getTime() - last) / DAY_MS)),
    predictedAt: new Date(last + window * DAY_MS),
    currencyCode: null,
    confidence: signedInSince ? 0.65 : 0.55,
    reasons: [
      { code: 'no_active_grant', since: new Date(last).toISOString() },
      { code: 'window', days: window },
      ...(signedInSince ? [{ code: 'signed_in_since' }] : []),
    ],
  };
}

/** Predictions v1 for one account (F-038-d): those that apply, each with its reasons. */
export function predictions(input: AccountInputs, ctx: PredictionContext, now: Date): PredictionRow[] {
  return [
    meterExhaustion(input, now),
    renewalProbability(input, now),
    rightSize(input, now),
    walletNeed(input, ctx, now),
    trialConversion(input, now),
    winBackWindow(input, now),
  ].filter((p): p is PredictionRow => p !== null);
}
