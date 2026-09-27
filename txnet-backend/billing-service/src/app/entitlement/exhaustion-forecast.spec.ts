/**
 * Exhaustion forecast — F-602 (spec 9.5). A prepaid Grant whose recent usage
 * spends what is left of its period's bytes within 5 days is told "at this
 * rate, your volume runs out in N days", once per usage period.
 *
 * What would break silently here, and nowhere else:
 *
 *  - **recent usage, not the period's average**: the rate is the bytes of the
 *    last 72 h over the time actually observed in them (never before the
 *    Grant ran), and under 24 h observed says nothing — one busy hour is not a
 *    habit;
 *  - **only when the volume runs out first**: a Grant whose end comes before
 *    its bytes do is the time notice's (F-601-e), and a forecast then would be
 *    false; nor past 95 % (that notice is the urgent one), a spent bag, an
 *    unlimited or metered Grant;
 *  - **once per usage period**: the Grant remembers the period it told for
 *    (`forecastNoticeFor`), the write is conditional on it and on the period
 *    read, and the event names that period for notification's ledger.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { exhaustionForecast, GrantExhaustionForecastService, type ForecastGrant } from './exhaustion-forecast';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';

const GB = BigInt(2 ** 30);
const DAY = 86_400_000;
const NOW = new Date('2026-09-27T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

/** 100 GB bag, 60 used, running 10 days, ending in 20. */
const grant: ForecastGrant = {
  billingMode: VariantBillingMode.prepaid,
  trafficUnlimited: false,
  purchasedBytes: BigInt(100) * GB,
  usagePeriodFromBytes: BigInt(0),
  consumedBytes: BigInt(60) * GB,
  endsAt: ahead(20),
  ranSince: ago(10),
};

describe('the forecast (F-602)', () => {
  it('40 GB left at 10 GB a day over the last 72 h: within 4 days', () => {
    expect(exhaustionForecast(grant, BigInt(30) * GB, NOW)).toEqual({ days: 4, remainingBytes: BigInt(40) * GB });
  });

  it('rounds up, and says "within a day" as 1', () => {
    expect(exhaustionForecast(grant, BigInt(27) * GB, NOW)?.days).toBe(5); // 4.4 days
    expect(exhaustionForecast({ ...grant, consumedBytes: BigInt(94) * GB }, BigInt(30) * GB, NOW)).toEqual({ days: 1, remainingBytes: BigInt(6) * GB });
  });

  it('says nothing beyond 5 days, or with nothing used in the window', () => {
    expect(exhaustionForecast(grant, BigInt(20) * GB, NOW)).toBeNull(); // 6 days
    expect(exhaustionForecast(grant, BigInt(0), NOW)).toBeNull();
  });

  it('counts only the time the Grant ran inside the window, and needs 24 h of it', () => {
    // Ran 2 days: 20 GB is 10 a day, not 6.7 — within 4 days.
    expect(exhaustionForecast({ ...grant, ranSince: ago(2) }, BigInt(20) * GB, NOW)?.days).toBe(4);
    expect(exhaustionForecast({ ...grant, ranSince: ago(0.5) }, BigInt(20) * GB, NOW)).toBeNull();
  });

  it('never when the end comes before the bytes run out — that is the time notice', () => {
    expect(exhaustionForecast({ ...grant, endsAt: ahead(3) }, BigInt(30) * GB, NOW)).toBeNull();
    expect(exhaustionForecast({ ...grant, endsAt: null }, BigInt(30) * GB, NOW)?.days).toBe(4);
    expect(exhaustionForecast({ ...grant, endsAt: ago(1) }, BigInt(30) * GB, NOW)).toBeNull();
  });

  it('never past 95 % of the period, with the bag spent, or with no bag', () => {
    expect(exhaustionForecast({ ...grant, consumedBytes: BigInt(95) * GB }, BigInt(30) * GB, NOW)).toBeNull();
    expect(exhaustionForecast({ ...grant, consumedBytes: BigInt(100) * GB }, BigInt(30) * GB, NOW)).toBeNull();
    expect(exhaustionForecast({ ...grant, trafficUnlimited: true, purchasedBytes: BigInt(0) }, BigInt(30) * GB, NOW)).toBeNull();
    expect(exhaustionForecast({ ...grant, billingMode: VariantBillingMode.metered }, BigInt(30) * GB, NOW)).toBeNull();
  });

  it('is a share of the period a renewal opened, not of the cumulative Quota', () => {
    // Renewed at 90 GB with 100 more: 190 bought, 100 used — 90 left, 10 % of the period.
    const renewed = { ...grant, purchasedBytes: BigInt(190) * GB, usagePeriodFromBytes: BigInt(90) * GB, consumedBytes: BigInt(100) * GB };
    expect(exhaustionForecast(renewed, BigInt(60) * GB, NOW)?.days).toBe(5); // 20 a day: 4.5
  });
});

describe('the sweep writes and emits once per period (F-602)', () => {
  function build(opts: { raced?: boolean; toldFor?: Date | null; periodAt?: Date | null; windowBytes?: bigint; consumed?: bigint } = {}) {
    const seen = {
      windows: [] as Array<Record<string, unknown>>,
      writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
      outbox: [] as Array<{ aggregateId: string; type: string; payload: Record<string, unknown> }>,
    };
    const tx = {
      grant: {
        findFirst: async () => ({
          id: GRANT,
          tenantId: TENANT,
          userId: USER,
          billingMode: VariantBillingMode.prepaid,
          trafficUnlimited: false,
          purchasedBytes: grant.purchasedBytes,
          usagePeriodFromBytes: grant.usagePeriodFromBytes,
          consumedBytes: opts.consumed ?? grant.consumedBytes,
          startsAt: ago(10),
          activatedAt: ago(10),
          endsAt: grant.endsAt,
          usagePeriodStartedAt: opts.periodAt ?? null,
          forecastNoticeFor: opts.toldFor ?? null,
          configs: [{ id: 'c1' }, { id: 'c2' }],
        }),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          seen.writes.push({ where, data });
          return { count: opts.raced ? 0 : 1 };
        },
      },
      trafficRawLog: {
        aggregate: async ({ where }: { where: Record<string, unknown> }) => {
          seen.windows.push(where);
          const bytes = opts.windowBytes ?? BigInt(30) * GB;
          return { _sum: { uploadBytes: bytes / BigInt(10), downloadBytes: bytes - bytes / BigInt(10) } };
        },
      },
      outboxEvent: {
        create: async ({ data }: { data: { aggregateId: string; type: string; payload: Record<string, unknown> } }) => {
          seen.outbox.push({ aggregateId: data.aggregateId, type: data.type, payload: data.payload });
          return { id: 'e1' };
        },
      },
    };
    const service = new GrantExhaustionForecastService({} as never, {} as never);
    return { service, tx: tx as never as Prisma.TransactionClient, seen };
  }

  it("sums every config's last 72 h, marks the period told conditionally, and emits the days and what is left", async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, NOW)).toBe(true);
    expect(seen.windows).toEqual([{ configId: { in: ['c1', 'c2'] }, recordedAt: { gt: ago(3), lte: NOW } }]);
    expect(seen.writes).toEqual([
      {
        where: { id: GRANT, status: GrantStatus.active, forecastNoticeFor: null, usagePeriodStartedAt: null },
        data: { forecastNoticeFor: ago(10) },
      },
    ]);
    expect(seen.outbox).toEqual([
      {
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_RUNS_OUT_SOON,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: ago(10).toISOString(), days: '4', remaining: '40 GB' },
      },
    ]);
  });

  it('a day or less is its own notice', async () => {
    const { service, tx, seen } = build({ consumed: BigInt(94) * GB });
    expect(await service.check(tx, GRANT, NOW)).toBe(true);
    expect(seen.outbox[0]?.type).toBe(OutboxEventType.GRANT_RUNS_OUT_WITHIN_A_DAY);
    expect(seen.outbox[0]?.payload).toMatchObject({ days: '1', remaining: '6.0 GB' });
  });

  it('a period already told is not read again; a renewal that opened a new one is', async () => {
    const told = build({ toldFor: ago(10) });
    expect(await told.service.check(told.tx, GRANT, NOW)).toBe(false);
    expect(told.seen.windows).toEqual([]);

    const renewed = build({ toldFor: ago(10), periodAt: ago(2) });
    expect(await renewed.service.check(renewed.tx, GRANT, NOW)).toBe(true);
    expect(renewed.seen.writes[0]).toEqual({
      where: { id: GRANT, status: GrantStatus.active, forecastNoticeFor: ago(10), usagePeriodStartedAt: ago(2) },
      data: { forecastNoticeFor: ago(2) },
    });
    expect(renewed.seen.outbox[0]?.payload).toMatchObject({ period: ago(2).toISOString() });
  });

  it('a forecast beyond 5 days writes nothing, so the next hour asks again', async () => {
    const { service, tx, seen } = build({ windowBytes: BigInt(20) * GB });
    expect(await service.check(tx, GRANT, NOW)).toBe(false);
    expect(seen.writes).toEqual([]);
    expect(seen.outbox).toEqual([]);
  });

  it('emits nothing when another sweep or a renewal wrote first', async () => {
    const { service, tx, seen } = build({ raced: true });
    expect(await service.check(tx, GRANT, NOW)).toBe(false);
    expect(seen.outbox).toEqual([]);
  });
});
