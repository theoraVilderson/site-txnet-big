import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { churnRisk, quotaExhaustion, type ResellerInputs } from './reseller-predictions';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date('2026-10-02T12:00:00Z');
const at = (ms: number) => new Date(now.getTime() + ms);

function reseller(over: Partial<ResellerInputs> = {}): ResellerInputs {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    windows: [],
    usage: [],
    sales: { last30: 0, prev30: 0 },
    subscription: null,
    wallet: null,
    ...over,
  };
}

const monthWindow = (included: number | null, includedUsed: number, end = at(20 * DAY)) => ({
  meter: 'campaign_sends_daily_max',
  period: 'month' as const,
  start: at(-10 * DAY),
  end,
  included,
  includedUsed,
  overageQty: 0,
  mode: 'stop' as const,
});

describe('quotaExhaustion (F-038-o1, ADR-0109 point 7: a tenant\'s quota per ADR-0107 key)', () => {
  it('forecasts the run-out from the last 7 days\' rate when it falls inside the window', () => {
    // 700 in 7 days = 100 a day; 1000 included, 600 used -> 400 left -> 4 days.
    const p = quotaExhaustion(
      reseller({ windows: [monthWindow(1000, 600)], usage: [{ meter: 'campaign_sends_daily_max', last7d: 700, firstAt: at(-30 * DAY) }] }),
      now,
    );
    expect(p?.kind).toBe('quota_exhaustion');
    expect(p?.value?.toNumber()).toBe(4);
    expect(p?.predictedAt).toEqual(at(4 * DAY));
    expect(p?.confidence).toBe(0.9);
    expect(p?.reasons[0]).toMatchObject({ code: 'quota_rate', meter: 'campaign_sends_daily_max', period: 'month', included: 1000, used: 600, perDay: 100 });
  });

  it('says nothing when the window ends before the quota would run out', () => {
    const p = quotaExhaustion(
      reseller({ windows: [monthWindow(1000, 600, at(2 * DAY))], usage: [{ meter: 'campaign_sends_daily_max', last7d: 700, firstAt: at(-30 * DAY) }] }),
      now,
    );
    expect(p).toBeNull();
  });

  it('a full window is now, whatever the rate — on overage the reseller is already paying past it', () => {
    const full = { ...monthWindow(1000, 1000), overageQty: 40, mode: 'overage' as const };
    const p = quotaExhaustion(reseller({ windows: [full] }), now);
    expect(p?.value?.toNumber()).toBe(0);
    expect(p?.predictedAt).toEqual(now);
    expect(p?.reasons[0]).toMatchObject({ code: 'quota_full', overageQty: 40, mode: 'overage' });
  });

  it('never forecasts from under 24 h of history, and never a window with no limit', () => {
    const young = quotaExhaustion(
      reseller({ windows: [monthWindow(1000, 990)], usage: [{ meter: 'campaign_sends_daily_max', last7d: 990, firstAt: at(-12 * HOUR) }] }),
      now,
    );
    expect(young).toBeNull();
    const unlimited = quotaExhaustion(
      reseller({ windows: [monthWindow(null, 5000)], usage: [{ meter: 'campaign_sends_daily_max', last7d: 5000, firstAt: at(-30 * DAY) }] }),
      now,
    );
    expect(unlimited).toBeNull();
  });

  it('names the soonest window first and keeps the others in its reasons; a shorter history is less sure', () => {
    const day = { meter: 'product:p1', period: 'day' as const, start: at(-12 * HOUR), end: at(12 * HOUR), included: 10, includedUsed: 8, overageQty: 0, mode: 'stop' as const };
    const week = { ...day, period: 'week' as const, start: at(-2 * DAY), end: at(5 * DAY), included: 50, includedUsed: 20 };
    // 3 days of history, 30 units -> 10 a day: the day's 2 left in 4.8 h, the week's 30 in 3 days.
    const p = quotaExhaustion(reseller({ windows: [week, day], usage: [{ meter: 'product:p1', last7d: 30, firstAt: at(-3 * DAY) }] }), now);
    expect(p?.reasons.map((r) => r.period)).toEqual(['day', 'week']);
    expect(p?.predictedAt).toEqual(at(0.2 * DAY));
    expect(p?.confidence).toBeCloseTo(0.5 + 0.4 * (3 / 7), 4);
  });
});

describe('churnRisk (F-038-o1)', () => {
  const sub = {
    currentPeriodEnd: at(10 * DAY),
    renewalWarnedAt: null,
    graceUntil: null,
    nextPackageId: null,
    renewalPrice: new Prisma.Decimal('50.00'),
    priceCurrency: 'USD',
  };

  it('needs a subscription', () => {
    expect(churnRisk(reseller(), now)).toBeNull();
  });

  it('is the base risk for a reseller with nothing against it, dated at its renewal', () => {
    const p = churnRisk(reseller({ subscription: sub, wallet: { balance: new Prisma.Decimal('80.00'), currencyCode: 'USD' } }), now);
    expect(p?.kind).toBe('churn_risk');
    expect(p?.value?.toNumber()).toBe(0.15);
    expect(p?.predictedAt).toEqual(sub.currentPeriodEnd);
    expect(p?.reasons.map((r) => r.code)).toEqual(['churn_base']);
  });

  it('adds a wallet short of the renewal inside 14 days, a warned or graced renewal, falling sales and a scheduled downgrade', () => {
    const p = churnRisk(
      reseller({
        subscription: { ...sub, renewalWarnedAt: at(-DAY), nextPackageId: '22222222-2222-4222-8222-222222222222' },
        wallet: { balance: new Prisma.Decimal('10.00'), currencyCode: 'USD' },
        sales: { last30: 4, prev30: 20 },
      }),
      now,
    );
    expect(p?.value?.toNumber()).toBe(0.95);
    expect(p?.reasons.map((r) => r.code)).toEqual(['churn_base', 'wallet_short', 'renewal_unpaid', 'sales_fell', 'downgrade_scheduled']);
  });

  it('never compares a wallet and a price in two currencies, and lowers the risk when sales grow', () => {
    const p = churnRisk(
      reseller({ subscription: sub, wallet: { balance: new Prisma.Decimal('1.00'), currencyCode: 'EUR' }, sales: { last30: 30, prev30: 20 } }),
      now,
    );
    expect(p?.value?.toNumber()).toBe(0.05);
    expect(p?.reasons.map((r) => r.code)).toEqual(['churn_base', 'sales_grew']);
  });
});
