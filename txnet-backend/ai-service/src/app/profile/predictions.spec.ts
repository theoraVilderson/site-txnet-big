import { Prisma } from '@prisma/client';

import { utcHour } from './meter-readings';
import {
  meterExhaustion,
  predictions,
  renewalProbability,
  rightSize,
  trialConversion,
  walletNeed,
  winBackWindow,
  type PredictionContext,
} from './predictions';
import type { AccountInputs } from './profile-features';

/**
 * F-038-d (ADR-0109 point 7): predictions v1, each with `reasons[]`. What
 * turns on it:
 *
 * - **Every prediction says why** — the CHECK refuses an empty `reasons`, but
 *   only at insert, so the whole hour's page would fail on one.
 * - **Exhaustion is F-602's rate** (the last 72 h, at least 24 h observed),
 *   from the engine's own readings, spread by the hour of week it is used in.
 * - **Money is a Decimal with its currency** (C-02), and a wallet need is never
 *   computed across two currencies.
 * - **Right size** follows the ADR's numbers: under 40 % over two periods is
 *   down; ran out early in two of the last three is up.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-07T10:30:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);
const GB = BigInt(1_000_000_000);
const D = (v: string) => new Prisma.Decimal(v);

const GRANT = 'g1';
const VARIANT = 'v1';

type G = AccountInputs['grants'][number];
const grant = (over: Partial<G> = {}): G => ({
  id: GRANT,
  variantId: VARIANT,
  source: 'purchase',
  status: 'active',
  billingMode: 'prepaid',
  trafficUnlimited: false,
  purchasedBytes: BigInt(100) * GB,
  consumedBytes: BigInt(40) * GB,
  usagePeriodFromBytes: BigInt(0),
  startsAt: ago(20 * DAY),
  activatedAt: ago(20 * DAY),
  endsAt: ahead(10 * DAY),
  updatedAt: ago(DAY),
  ...over,
});

function inputs(over: Partial<AccountInputs> = {}): AccountInputs {
  return {
    userId: 'u1',
    createdAt: ago(100 * DAY),
    grants: [],
    renewals: [],
    readings: [],
    walletTransactions: [],
    wallet: null,
    payments: [],
    signIns: [],
    notices: [],
    ...over,
  };
}

/** `bytes` spread evenly over the `hours` hours before now, one reading an hour. */
function evenUse(bytes: bigint, hours: number, grantId = GRANT): AccountInputs['readings'] {
  return Array.from({ length: hours }, (_, i) => ({
    grantId,
    meterKey: 'vpn.traffic',
    hour: utcHour(ago((i + 1) * HOUR)),
    delta: bytes / BigInt(hours),
  }));
}

const ctx: PredictionContext = { prices: new Map(), presets: null };

describe('every prediction says why (F-038-d)', () => {
  it('returns only predictions with a non-empty reasons array and a confidence in 0–1', () => {
    const all = predictions(
      inputs({
        grants: [grant()],
        readings: evenUse(BigInt(30) * GB, 72),
        wallet: { id: 'w', balance: D('1.00'), held: D('0'), currencyCode: 'USD' },
        renewals: [{ grantId: GRANT, createdAt: ago(40 * DAY), plan: true, bytes: BigInt(100) * GB, endsAtBefore: ago(40 * DAY), endsAtAfter: ahead(10 * DAY) }],
      }),
      { prices: new Map([[VARIANT, { amount: D('5.00'), currencyCode: 'USD' }]]), presets: null },
      NOW,
    );
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.reasons.length).toBeGreaterThan(0);
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(p.currencyCode !== null).toBe(p.kind === 'wallet_need');
    }
  });
});

describe('meter exhaustion — F-602\'s rate, from readings', () => {
  it('runs out at the recent rate: 60 GB left at 10 GB a day is six days', () => {
    const p = meterExhaustion(inputs({ grants: [grant()], readings: evenUse(BigInt(30) * GB, 72) }), NOW);
    expect(p?.kind).toBe('meter_exhaustion');
    expect(Number(p?.value)).toBeCloseTo(6, 1);
    expect(Math.abs((p?.predictedAt?.getTime() ?? 0) - ahead(6 * DAY).getTime())).toBeLessThan(2 * HOUR);
    expect(p?.reasons[0]).toMatchObject({ code: 'recent_rate', grantId: GRANT });
  });

  it('says nothing under 24 h observed, with no use, or when the Grant ends first', () => {
    expect(meterExhaustion(inputs({ grants: [grant({ activatedAt: ago(12 * HOUR), startsAt: ago(12 * HOUR) })], readings: evenUse(BigInt(5) * GB, 12) }), NOW)).toBeNull();
    expect(meterExhaustion(inputs({ grants: [grant()] }), NOW)).toBeNull();
    expect(meterExhaustion(inputs({ grants: [grant({ endsAt: ahead(3 * DAY) })], readings: evenUse(BigInt(30) * GB, 72) }), NOW)).toBeNull();
    expect(meterExhaustion(inputs({ grants: [grant({ trafficUnlimited: true })], readings: evenUse(BigInt(30) * GB, 72) }), NOW)).toBeNull();
  });

  it('spreads the rate over the hours of week the account uses', () => {
    // Uses only in one hour a day: the bytes are spent then, not evenly.
    const readings = Array.from({ length: 28 }, (_, d) => ({
      grantId: GRANT,
      meterKey: 'vpn.traffic',
      hour: utcHour(ago(d * DAY + 2 * HOUR)),
      delta: BigInt(10) * GB,
    }));
    const p = meterExhaustion(inputs({ grants: [grant({ endsAt: ahead(30 * DAY) })], readings }), NOW);
    // 60 GB left at 10 GB a day, all of it at 08:00 UTC: the 6th day's 08:00.
    expect(p?.predictedAt?.getUTCHours()).toBe(8);
    expect(p?.reasons.some((r) => r.code === 'weighted_by_hour_of_week')).toBe(true);
  });
});

describe('renewal probability', () => {
  it('raises the odds for a past renewal and use, lowers them for an idle week', () => {
    const renewed = renewalProbability(
      inputs({
        grants: [grant({ consumedBytes: BigInt(80) * GB })],
        readings: evenUse(BigInt(10) * GB, 48),
        renewals: [{ grantId: GRANT, createdAt: ago(40 * DAY), plan: true, bytes: BigInt(100) * GB, endsAtBefore: null, endsAtAfter: ahead(10 * DAY) }],
      }),
      NOW,
    );
    const idle = renewalProbability(inputs({ grants: [grant({ consumedBytes: BigInt(5) * GB })] }), NOW);
    expect(Number(renewed?.value)).toBeGreaterThan(0.5);
    expect(Number(idle?.value)).toBeLessThan(0.5);
    expect(idle?.reasons.map((r) => r.code)).toContain('idle_7d');
    expect(renewed?.predictedAt).toEqual(ahead(10 * DAY));
  });

  it('is not predicted for a trial or a Grant with no end', () => {
    expect(renewalProbability(inputs({ grants: [grant({ source: 'trial' })] }), NOW)).toBeNull();
    expect(renewalProbability(inputs({ grants: [grant({ endsAt: null })] }), NOW)).toBeNull();
  });
});

describe('right size (point 7)', () => {
  /** Periods of 30 days, each bought 100 GB; `used[i]` GB spread at its start; renewed at `ranOut` days in, or on time. */
  function periods(used: number[], ranOutDays: Array<number | null>) {
    const start0 = ago(used.length * 30 * DAY + DAY);
    const renewals: AccountInputs['renewals'] = [];
    const readings: AccountInputs['readings'] = [{ grantId: GRANT, meterKey: 'vpn.traffic', hour: utcHour(new Date(start0.getTime() - HOUR)), delta: BigInt(0) }];
    let at = start0;
    for (let i = 0; i < used.length; i += 1) {
      const planned = new Date(at.getTime() + 30 * DAY);
      renewals.push({ grantId: GRANT, createdAt: at, plan: true, bytes: BigInt(100) * GB, endsAtBefore: null, endsAtAfter: planned });
      readings.push({ grantId: GRANT, meterKey: 'vpn.traffic', hour: utcHour(new Date(at.getTime() + HOUR)), delta: BigInt(used[i]) * GB });
      at = ranOutDays[i] === null ? planned : new Date(at.getTime() + (ranOutDays[i] as number) * DAY);
    }
    // The renewal that closes the last period.
    renewals.push({ grantId: GRANT, createdAt: at, plan: true, bytes: BigInt(100) * GB, endsAtBefore: null, endsAtAfter: new Date(at.getTime() + 30 * DAY) });
    return { renewals, readings };
  }

  it('suggests down after two periods under 40 %', () => {
    const p = rightSize(inputs({ grants: [grant()], ...periods([30, 35], [null, null]) }), NOW);
    expect(p?.reasons[0]).toMatchObject({ code: 'size_down', grantId: GRANT });
    expect(Number(p?.value)).toBeCloseTo(0.35, 2);
  });

  it('suggests up after running out early in two of the last three', () => {
    const p = rightSize(inputs({ grants: [grant()], ...periods([100, 60, 100], [15, null, 20]) }), NOW);
    expect(p?.reasons[0]).toMatchObject({ code: 'size_up', grantId: GRANT });
    // Ran out at half and two thirds of the period: needs ~1.75x.
    expect(Number(p?.value)).toBeCloseTo(1.75, 2);
  });

  it('says nothing for one low period, or for a period the readings do not cover', () => {
    expect(rightSize(inputs({ grants: [grant()], ...periods([30, 80], [null, null]) }), NOW)).toBeNull();
    const { renewals } = periods([30, 35], [null, null]);
    expect(rightSize(inputs({ grants: [grant()], renewals, readings: [] }), NOW)).toBeNull();
  });
});

describe('wallet need (C-02)', () => {
  const priced: PredictionContext = { prices: new Map([[VARIANT, { amount: D('7.50'), currencyCode: 'USD' }]]), presets: { amounts: [D('5'), D('10'), D('20')], currencyCode: 'USD' } };

  it('is the next two renewals minus what is available, rounded up to a preset', () => {
    const p = walletNeed(inputs({ grants: [grant()], wallet: { id: 'w', balance: D('6.00'), held: D('2.00'), currencyCode: 'USD' } }), priced, NOW);
    // 2 x 7.50 - (6.00 - 2.00) = 11.00 -> the 20 preset.
    expect(p?.value?.toFixed(2)).toBe('20.00');
    expect(p?.currencyCode).toBe('USD');
    expect(p?.reasons.map((r) => r.code)).toEqual(['next_two_renewals', 'available', 'rounded_to_preset']);
  });

  it('rounds past the largest preset in its multiples, and keeps cents with no presets', () => {
    const rich = walletNeed(inputs({ grants: [grant()], wallet: { id: 'w', balance: D('0'), held: D('0'), currencyCode: 'USD' } }), { ...priced, prices: new Map([[VARIANT, { amount: D('25'), currencyCode: 'USD' }]]) }, NOW);
    expect(rich?.value?.toFixed(2)).toBe('60.00');
    const bare = walletNeed(inputs({ grants: [grant()], wallet: { id: 'w', balance: D('3.10'), held: D('0'), currencyCode: 'USD' } }), { ...priced, presets: null }, NOW);
    expect(bare?.value?.toFixed(2)).toBe('11.90');
  });

  it('says nothing when the wallet covers it, or across two currencies', () => {
    expect(walletNeed(inputs({ grants: [grant()], wallet: { id: 'w', balance: D('15.00'), held: D('0'), currencyCode: 'USD' } }), priced, NOW)).toBeNull();
    expect(walletNeed(inputs({ grants: [grant()], wallet: { id: 'w', balance: D('0'), held: D('0'), currencyCode: 'IRR' } }), priced, NOW)).toBeNull();
    expect(walletNeed(inputs({ grants: [grant()], wallet: null }), priced, NOW)).toBeNull();
  });
});

describe('trial conversion', () => {
  const trial = grant({ source: 'trial', purchasedBytes: BigInt(10) * GB, endsAt: ahead(2 * DAY) });

  it('rises with use and a top-up, and is only for an account that never paid', () => {
    const cold = trialConversion(inputs({ grants: [{ ...trial, consumedBytes: BigInt(0) }] }), NOW);
    const warm = trialConversion(
      inputs({
        grants: [{ ...trial, consumedBytes: BigInt(5) * GB }],
        walletTransactions: [{ direction: 'credit', reasonType: 'payment_gateway', createdAt: ago(DAY) }],
      }),
      NOW,
    );
    expect(Number(cold?.value)).toBeLessThan(Number(warm?.value));
    expect(cold?.reasons.map((r) => r.code)).toContain('never_connected');
    expect(warm?.predictedAt).toEqual(ahead(2 * DAY));
    expect(trialConversion(inputs({ grants: [trial, grant({ id: 'g2' })] }), NOW)).toBeNull();
  });
});

describe('win-back window (14 / 30 / 60 days)', () => {
  const ended = (daysAgo: number) => grant({ status: 'expired', endsAt: ago(daysAgo * DAY), updatedAt: ago(daysAgo * DAY - HOUR) });

  it('names the next window after the last Grant ended', () => {
    expect(winBackWindow(inputs({ grants: [ended(3)] }), NOW)?.predictedAt).toEqual(ahead(11 * DAY));
    expect(winBackWindow(inputs({ grants: [ended(20)] }), NOW)?.predictedAt).toEqual(ahead(10 * DAY));
    expect(winBackWindow(inputs({ grants: [ended(45)] }), NOW)?.reasons).toContainEqual({ code: 'window', days: 60 });
  });

  it('is nothing past 60 days, with an active Grant, or never having had one', () => {
    expect(winBackWindow(inputs({ grants: [ended(61)] }), NOW)).toBeNull();
    expect(winBackWindow(inputs({ grants: [ended(5), grant({ id: 'g2' })] }), NOW)).toBeNull();
    expect(winBackWindow(inputs(), NOW)).toBeNull();
  });
});

it('uses the context only for money (the default context predicts no wallet need)', () => {
  expect(walletNeed(inputs({ grants: [grant()], wallet: { id: 'w', balance: D('0'), held: D('0'), currencyCode: 'USD' } }), ctx, NOW)).toBeNull();
});
