import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { UsageReport } from '../admin/usage-report';
import { usageForecast, walletNeedPrediction, walletRunOut } from './usage-forecast';

/**
 * F-1525-a (ADR-0109 point 7; §24.3: the invisible layer never moves money —
 * a forecast and a suggestion to a human, no more).
 *
 * The failures worth a spec: a run-out from a day of history read as a week's
 * rate; a refund counted as spend; spend in a currency the wallet no longer
 * keeps (C-02) added to it; a top-up that does not cover 30 days, or one
 * asked of a wallet that already does; a tenant's use summed across meters of
 * two units.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const D = (v: string) => new Prisma.Decimal(v);

describe('walletRunOut', () => {
  it('runs the balance down at the last 7 days\' net spend and asks what covers 30 days, rounded up to a whole unit', () => {
    // 140 charged, 0 refunded over 7 days = 20 a day; 90 left -> 4.5 days; 30 days = 600, so 510 more.
    const spend = Array.from({ length: 7 }, (_, i) => ({ day: ago((i + 1) * DAY), charged: D('20.00'), refunded: D('0'), currencyCode: 'USD' }));
    const r = walletRunOut({ balance: D('90.00'), currencyCode: 'USD', spend, firstChargeAt: ago(40 * DAY) }, now);
    expect(r?.perDay.toFixed(2)).toBe('20.00');
    expect(r?.runsOutAt).toEqual(new Date(now.getTime() + 4.5 * DAY));
    expect(r?.topUp.toFixed(2)).toBe('510.00');
    expect(r?.observedDays).toBe(7);
  });

  it('nets refunds, ignores another currency and anything older than 7 days, and reads a younger wallet over its own history', () => {
    const spend = [
      { day: ago(1 * DAY), charged: D('30.00'), refunded: D('10.00'), currencyCode: 'USD' },
      { day: ago(2 * DAY), charged: D('500.00'), refunded: D('0'), currencyCode: 'EUR' },
      { day: ago(9 * DAY), charged: D('999.00'), refunded: D('0'), currencyCode: 'USD' },
    ];
    // First charge 2 days ago: 20 net over 2 days = 10 a day.
    const r = walletRunOut({ balance: D('15.50'), currencyCode: 'USD', spend, firstChargeAt: ago(2 * DAY) }, now);
    expect(r?.perDay.toFixed(2)).toBe('10.00');
    expect(r?.topUp.toFixed(2)).toBe('285.00');
  });

  it('none from under a day of history, from no net spend, and no top-up for a wallet that already covers 30 days', () => {
    const one = [{ day: ago(HOUR), charged: D('50.00'), refunded: D('0'), currencyCode: 'USD' }];
    expect(walletRunOut({ balance: D('1.00'), currencyCode: 'USD', spend: one, firstChargeAt: ago(12 * HOUR) }, now)).toBeNull();
    const refunded = [{ day: ago(DAY), charged: D('5.00'), refunded: D('5.00'), currencyCode: 'USD' }];
    expect(walletRunOut({ balance: D('1.00'), currencyCode: 'USD', spend: refunded, firstChargeAt: ago(10 * DAY) }, now)).toBeNull();
    const steady = Array.from({ length: 7 }, (_, i) => ({ day: ago((i + 1) * DAY), charged: D('1.00'), refunded: D('0'), currencyCode: 'USD' }));
    expect(walletRunOut({ balance: D('100.00'), currencyCode: 'USD', spend: steady, firstChargeAt: ago(30 * DAY) }, now)?.topUp.toFixed(2)).toBe('0.00');
  });
});

describe('walletNeedPrediction', () => {
  it('a wallet running out within 30 days is a wallet_need: the top-up, in the wallet\'s currency, dated at the run-out', () => {
    const p = walletNeedPrediction({ perDay: D('20.00'), observedDays: 7, runsOutAt: new Date(now.getTime() + 4.5 * DAY), topUp: D('510.00'), balance: D('90.00'), currencyCode: 'USD' }, now);
    expect(p).toMatchObject({ kind: 'wallet_need', currencyCode: 'USD', predictedAt: new Date(now.getTime() + 4.5 * DAY), confidence: 0.9 });
    expect(p?.value?.toFixed(2)).toBe('510.00');
    expect(p?.reasons[0]).toMatchObject({ code: 'wholesale_rate', perDay: '20.00', observedDays: 7, balance: '90.00', currencyCode: 'USD' });
  });

  it('none past 30 days', () => {
    expect(walletNeedPrediction({ perDay: D('1.00'), observedDays: 7, runsOutAt: new Date(now.getTime() + 31 * DAY), topUp: D('0'), balance: D('31.00'), currencyCode: 'USD' }, now)).toBeNull();
  });
});

describe('usageForecast', () => {
  it('per meter, never summed across two: the last 7 days, a day\'s mean and 30 days of it', () => {
    const rows = [
      ...Array.from({ length: 7 * 24 }, (_, i) => ({ meterKey: 'vpn.traffic', hour: ago((i + 1) * HOUR), delta: BigInt(1024) })),
      { meterKey: 'vpn.traffic', hour: ago(20 * DAY), delta: BigInt('1000000000000') },
      { meterKey: 'sms.sent', hour: ago(30 * HOUR), delta: BigInt(48) },
    ];
    const f = usageForecast(rows, now);
    expect(f).toEqual([
      // 48 over 30 hours of history: 38 a day (whole units, down), 1152 in 30 days.
      { meterKey: 'sms.sent', last7d: '48', perDay: '38', next30d: '1152', observedHours: 30 },
      { meterKey: 'vpn.traffic', last7d: String(7 * 24 * 1024), perDay: String(24 * 1024), next30d: String(30 * 24 * 1024), observedHours: 168 },
    ]);
  });

  it('a meter seen under 24 h has no forecast yet', () => {
    expect(usageForecast([{ meterKey: 'vpn.traffic', hour: ago(5 * HOUR), delta: BigInt(100) }], now)).toEqual([]);
  });
});

describe('UsageReport (F-1525-a)', () => {
  const PLATFORM = '00000000-0000-4000-8000-0000000000f1';
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b1';
  // Hourly totals per tenant: A 24 hours of 100, B 48 hours of 50 (each over its own history).
  const hours: Record<string, Array<{ meterKey: string; hour: Date; delta: bigint }>> = {
    [A]: Array.from({ length: 24 * 3 }, (_, i) => ({ meterKey: 'vpn.traffic', hour: ago((i + 1) * HOUR), delta: BigInt(100) })),
    [B]: Array.from({ length: 24 * 3 }, (_, i) => ({ meterKey: 'vpn.traffic', hour: ago((i + 1) * HOUR), delta: BigInt(50) })),
    [PLATFORM]: [],
  };
  function fake(tenantType: string, first: Record<string, Date> = {}) {
    // The query names its tenant: the fake answers that tenant's hours.
    const firstHour: Record<string, Date> = { [A]: ago(72 * HOUR), [B]: ago(72 * HOUR), ...first };
    const tx = {
      $executeRaw: vi.fn(async () => 1),
      $queryRaw: vi.fn(async (s: TemplateStringsArray, ...values: unknown[]) => {
        const id = values.find((v): v is string => typeof v === 'string' && v in hours) ?? '';
        return s.join('').includes('MIN("hour")') ? [{ hour: firstHour[id] ?? null }] : (hours[id] ?? []);
      }),
    };
    const prisma = {
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      tenant: { findUnique: vi.fn(async () => ({ tenantType })), findMany: vi.fn(async () => [{ id: A }, { id: B }, { id: PLATFORM }]) },
    };
    const resellers = { wholesale: vi.fn(async () => ({ balance: D('90.00'), currencyCode: 'USD', firstChargeAt: ago(40 * DAY), spend: Array.from({ length: 7 }, (_, i) => ({ day: ago((i + 1) * DAY), charged: D('20.00'), refunded: D('0'), currencyCode: 'USD' })) })) };
    return { report: new UsageReport(prisma as never, resellers as never), resellers };
  }

  it('a tenant\'s own: its meters and its billing wallet\'s run-out, money as decimal strings with the currency', async () => {
    const { report } = fake('reseller');
    const r = await report.forecast(A, now);
    expect(r.meters).toEqual([{ meterKey: 'vpn.traffic', last7d: String(72 * 100), perDay: String(2400), next30d: String(72000), observedHours: 72 }]);
    expect(r.wallet).toEqual({ balance: '90.00', perDay: '20.00', runsOutAt: new Date(now.getTime() + 4.5 * DAY).toISOString(), topUp: '510.00', currencyCode: 'USD', observedDays: 7 });
  });

  it('dates a meter from the tenant\'s first reading: idle hours write no row, and a quiet week is not a young meter', async () => {
    // A's readings began 30 days ago, so its 72 hours of use are a week's: 7200 / 7 a day.
    const r = await fake('reseller', { [A]: ago(30 * DAY) }).report.forecast(A, now);
    expect(r.meters[0]).toMatchObject({ perDay: String(Math.floor((7200 * 24) / 168)), observedHours: 168 });
  });

  it('capacity: the platform owner only — the sum of every tenant\'s meters, and how many tenants were measured', async () => {
    await expect(fake('reseller').report.capacity(A, now)).rejects.toThrow();
    const r = await fake('platform_owner').report.capacity(PLATFORM, now);
    expect(r).toEqual({ meters: [{ meterKey: 'vpn.traffic', last7d: String(72 * 150), perDay: String(3600), next30d: String(108000), observedHours: 72 }], tenantsMeasured: 2, tenants: 3 });
  });
});
