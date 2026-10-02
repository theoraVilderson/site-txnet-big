import { Prisma } from '@prisma/client';

import { ACTIVE_HOURS_HALF_LIFE_DAYS, activeHours, HOURS_OF_WEEK, hourOfWeek } from './active-hours';
import { readingsFor, utcHour } from './meter-readings';
import { accountFeatures, type AccountInputs } from './profile-features';

/**
 * F-038-c (ADR-0109 points 6, 7, 14): the hourly profile of one account, from
 * the database only. Three rules turn on it, and each fails silently:
 *
 * - **The readings are the rate.** `ai-service` reads no network table, so a
 *   meter's hourly growth is what F-038-d's exhaustion date divides by. A
 *   reading that double-counts, or writes a row for every idle hour, is a
 *   wrong date or a table that grows by every Grant every hour.
 * - **Active hours are UTC, hour of week, decayed over 28 days.** A local
 *   bucket or no decay schedules every suggestion at the wrong time.
 * - **The features count only their window and their own account.**
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A Wednesday, 10:00 UTC.
const NOW = new Date('2026-10-07T10:30:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const USER = '00000000-0000-4000-8000-000000000001';
const GRANT = '00000000-0000-4000-8000-0000000000a1';

describe('meter readings (F-038-c)', () => {
  const hour = utcHour(NOW);

  it('samples on the UTC hour', () => {
    expect(hour.toISOString()).toBe('2026-10-07T10:00:00.000Z');
  });

  it('writes a baseline the first time, growth after, and nothing for an idle hour', () => {
    const counter = { userId: USER, grantId: GRANT, meterKey: 'vpn.traffic', counter: BigInt(500) };
    expect(readingsFor([counter], new Map(), hour)).toEqual([{ ...counter, hour, delta: BigInt(0) }]);

    const last = new Map([[`${GRANT}|vpn.traffic`, BigInt(200)]]);
    expect(readingsFor([counter], last, hour)).toEqual([{ ...counter, hour, delta: BigInt(300) }]);

    expect(readingsFor([counter], new Map([[`${GRANT}|vpn.traffic`, BigInt(500)]]), hour)).toEqual([]);
  });

  it('takes a smaller counter as a new baseline, never a negative growth', () => {
    const counter = { userId: USER, grantId: GRANT, meterKey: 'vpn.traffic', counter: BigInt(100) };
    const last = new Map([[`${GRANT}|vpn.traffic`, BigInt(900)]]);
    expect(readingsFor([counter], last, hour)).toEqual([{ ...counter, hour, delta: BigInt(0) }]);
  });
});

describe('active hours (F-038-c, ADR-0109 point 7)', () => {
  it('buckets by UTC hour of week, Monday 00:00 first', () => {
    expect(HOURS_OF_WEEK).toBe(168);
    expect(hourOfWeek(new Date('2026-10-05T00:10:00Z'))).toBe(0); // Monday
    expect(hourOfWeek(new Date('2026-10-07T10:59:00Z'))).toBe(2 * 24 + 10); // Wednesday
    expect(hourOfWeek(new Date('2026-10-11T23:00:00Z'))).toBe(167); // Sunday
    // A Tehran evening is still its UTC hour.
    expect(hourOfWeek(new Date('2026-10-07T20:00:00+03:30'))).toBe(2 * 24 + 16);
  });

  it('is shares that sum to 1, and all zero with no activity', () => {
    expect(activeHours([], NOW)).toEqual(new Array(168).fill(0));
    const shares = activeHours([ago(1 * HOUR), ago(25 * HOUR), ago(7 * DAY)], NOW);
    expect(shares).toHaveLength(168);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('halves an event every 28 days', () => {
    expect(ACTIVE_HOURS_HALF_LIFE_DAYS).toBe(28);
    // Same hour of week, one now and one four weeks back: 1 : 0.5.
    const recent = ago(HOUR);
    const old = ago(28 * DAY + HOUR);
    const otherHour = ago(2 * HOUR);
    const shares = activeHours([recent, old, otherHour], NOW);
    expect(shares[hourOfWeek(recent)]).toBeCloseTo(1.5 / 2.5, 3);
    expect(shares[hourOfWeek(otherHour)]).toBeCloseTo(1 / 2.5, 3);
  });
});

function inputs(over: Partial<AccountInputs> = {}): AccountInputs {
  return {
    userId: USER,
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

const grant = (over: Partial<AccountInputs['grants'][number]> = {}): AccountInputs['grants'][number] => ({
  id: GRANT,
  variantId: null,
  source: 'purchase',
  status: 'active',
  billingMode: 'prepaid',
  trafficUnlimited: false,
  purchasedBytes: BigInt(100),
  consumedBytes: BigInt(40),
  usagePeriodFromBytes: BigInt(0),
  startsAt: ago(20 * DAY),
  activatedAt: ago(20 * DAY),
  endsAt: new Date(NOW.getTime() + 10 * DAY),
  updatedAt: ago(DAY),
  ...over,
});

describe('account features (F-038-c)', () => {
  it('counts Grants by state and names the next end and the last one', () => {
    const { features } = accountFeatures(
      inputs({
        grants: [
          grant(),
          grant({ id: 'g2', source: 'trial', endsAt: new Date(NOW.getTime() + 2 * DAY) }),
          grant({ id: 'g3', status: 'expired', endsAt: ago(40 * DAY) }),
          grant({ id: 'g4', status: 'exhausted', endsAt: new Date(NOW.getTime() + 5 * DAY), updatedAt: ago(3 * DAY) }),
        ],
      }),
      NOW,
    );
    expect(features.grants).toEqual({
      active: 2,
      trialActive: true,
      total: 4,
      everPurchased: true,
      nextEndsAt: new Date(NOW.getTime() + 2 * DAY).toISOString(),
      // An exhausted Grant ended when it ran out, not at its end date.
      lastEndedAt: ago(3 * DAY).toISOString(),
    });
  });

  it('keeps money as a decimal string with its currency, available = balance - held (C-02)', () => {
    const { features } = accountFeatures(
      inputs({ wallet: { id: 'w', balance: new Prisma.Decimal('120.50'), held: new Prisma.Decimal('20.25'), currencyCode: 'IRR' } }),
      NOW,
    );
    expect(features.wallet).toEqual({ available: '100.25', currencyCode: 'IRR' });
  });

  it('counts payments, coupons, top-ups, sign-ins and reads only inside their windows', () => {
    const paid = (at: Date, status: 'success' | 'failed', discount = '0') => ({
      status,
      createdAt: at,
      discountApplied: new Prisma.Decimal(discount),
    });
    const { features } = accountFeatures(
      inputs({
        payments: [paid(ago(DAY), 'success', '5'), paid(ago(10 * DAY), 'success'), paid(ago(2 * DAY), 'failed'), paid(ago(200 * DAY), 'success')],
        walletTransactions: [
          { direction: 'credit', reasonType: 'payment_gateway', createdAt: ago(3 * DAY) },
          { direction: 'debit', reasonType: 'product_purchase', createdAt: ago(3 * DAY) },
          { direction: 'credit', reasonType: 'payment_gateway', createdAt: ago(181 * DAY) },
        ],
        signIns: [ago(HOUR), ago(5 * DAY), ago(31 * DAY)],
        notices: [
          { createdAt: ago(2 * DAY), readAt: ago(DAY) },
          { createdAt: ago(3 * DAY), readAt: null },
          { createdAt: ago(40 * DAY), readAt: ago(39 * DAY) },
        ],
      }),
      NOW,
    );
    expect(features.payments).toEqual({ succeeded180d: 2, failed180d: 1, couponUsed180d: 1, lastSucceededAt: ago(DAY).toISOString() });
    expect(features.topUps180d).toBe(1);
    expect(features.signIns).toEqual({ last30d: 2, lastAt: ago(HOUR).toISOString() });
    expect(features.notices).toEqual({ delivered30d: 2, read30d: 1 });
  });

  it('builds active hours from use, sign-ins, reads and payments — not from idle readings', () => {
    const used = ago(3 * HOUR);
    const { activeHours: hours, features } = accountFeatures(
      inputs({
        readings: [
          { grantId: GRANT, meterKey: 'vpn.traffic', hour: utcHour(used), delta: BigInt(10) },
          // The baseline: a reading, not a use.
          { grantId: GRANT, meterKey: 'vpn.traffic', hour: utcHour(ago(50 * HOUR)), delta: BigInt(0) },
        ],
        signIns: [used],
      }),
      NOW,
    );
    expect(hours[hourOfWeek(used)]).toBeCloseTo(1, 10);
    expect(features.usage).toEqual({ hoursUsed30d: 1, lastUsedAt: utcHour(used).toISOString() });
    expect(features.lastActiveAt).toBe(used.toISOString());
  });
});
