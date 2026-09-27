/**
 * Time thresholds — F-601-e (spec 9.5) — and the 24 h hold — F-601-n. An
 * active Grant is told 7, 3 and 1 day(s) before its end, once each per end;
 * a 7- or 3-day level and a held 50 / 80 % usage level wait up to 24 h for
 * each other, and are one message when both are due. The level arithmetic is
 * shared-core's (`retention-levels.spec.ts`); this is the sweep's write.
 *
 * What would break silently here, and nowhere else:
 *
 *  - **a held level stays due**: the clock does not move past a 7- or 3-day
 *    level until it is told, or the next hour would never see it again;
 *  - **the words are as of the telling**: a level held a day says the days
 *    left and the volume left *then*, never what was true when it fell due;
 *  - **a held usage level that is no longer true is dropped, untold**: a
 *    renewal opened a new period, or the bag is spent (the cutoff's notice);
 *  - **each is emitted once**: the write is conditional on the clock and the
 *    held level it read, and the event names the period for notification's
 *    ledger (invariant 14).
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GrantEndNoticeService } from './end-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';

const DAY = 86_400_000;
const GB = BigInt(1024 ** 3);
const END = new Date('2026-10-27T10:00:00.000Z');
const ACTIVE = new Date('2026-09-27T10:00:00.000Z');
const before = (days: number) => new Date(END.getTime() - days * DAY);
const after = (at: Date, hours: number) => new Date(at.getTime() + hours * 3_600_000);

function build(over: Record<string, unknown> = {}, opts: { raced?: boolean } = {}) {
  const row = {
    id: GRANT,
    tenantId: TENANT,
    userId: USER,
    startsAt: ACTIVE,
    activatedAt: ACTIVE,
    endsAt: END,
    endNoticeFor: null,
    endNoticeAt: null,
    billingMode: VariantBillingMode.prepaid,
    trafficUnlimited: false,
    purchasedBytes: BigInt(50) * GB,
    consumedBytes: BigInt(20) * GB,
    usagePeriodStartedAt: null,
    usageNoticeLevel: null,
    usageNoticeSince: null,
    ...over,
  };
  const seen = {
    writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
    outbox: [] as Array<{ type: string; payload: Record<string, unknown> }>,
  };
  const tx = {
    grant: {
      findFirst: async () => row,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        seen.writes.push({ where, data });
        return { count: opts.raced ? 0 : 1 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
        seen.outbox.push({ type: data.type, payload: data.payload });
        return { id: 'e1' };
      },
    },
  };
  const service = new GrantEndNoticeService({} as never, {} as never);
  return { service, tx: tx as never as Prisma.TransactionClient, seen };
}

const who = { tenantId: TENANT, userId: USER, grantId: GRANT };

describe('a time level alone (F-601-e, F-601-n)', () => {
  it('holds a 7-day level for 24 h without moving the clock', async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, after(before(7), 23))).toBeNull();
    expect(seen.writes).toEqual([]);
    expect(seen.outbox).toEqual([]);
  });

  it('then tells it with the days left at that moment, moving the clock conditionally on the one it read', async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, after(before(7), 24))).toBe(OutboxEventType.GRANT_ENDS_IN_7D);
    expect(seen.writes).toEqual([
      {
        where: {
          id: GRANT,
          status: GrantStatus.active,
          endsAt: END,
          endNoticeFor: null,
          endNoticeAt: null,
          usageNoticeLevel: null,
          usageNoticeSince: null,
        },
        data: { endNoticeFor: END, endNoticeAt: before(3) },
      },
    ]);
    expect(seen.outbox).toEqual([{ type: OutboxEventType.GRANT_ENDS_IN_7D, payload: { ...who, period: END.toISOString(), days: '6' } }]);
  });

  it('tells the last day at once', async () => {
    const { service, tx, seen } = build({ endNoticeFor: END, endNoticeAt: before(1) });
    expect(await service.check(tx, GRANT, before(1))).toBe(OutboxEventType.GRANT_ENDS_IN_1D);
    expect(seen.outbox[0]?.payload).toEqual({ ...who, period: END.toISOString(), days: '1' });
  });

  it('sets the clock for an end with no level due, and emits nothing', async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, before(8))).toBeNull();
    expect(seen.writes[0]?.data).toEqual({ endNoticeFor: END, endNoticeAt: before(7) });
    expect(seen.outbox).toEqual([]);
  });
});

describe('a held usage level (F-601-n)', () => {
  it('is told with a time level the moment both are due — one message, what is left as of now', async () => {
    const crossed = after(before(3), -5);
    const { service, tx, seen } = build({ endNoticeFor: END, endNoticeAt: before(3), usageNoticeLevel: 80, usageNoticeSince: crossed });
    expect(await service.check(tx, GRANT, before(3))).toBe(OutboxEventType.GRANT_USAGE_80);
    expect(seen.writes[0]?.data).toEqual({ endNoticeFor: END, endNoticeAt: before(1), usageNoticeLevel: null, usageNoticeSince: null });
    expect(seen.outbox).toEqual([
      {
        type: OutboxEventType.GRANT_USAGE_80,
        payload: {
          ...who,
          period: ACTIVE.toISOString(),
          percent: '80',
          remaining: '30 GB',
          endNotice: OutboxEventType.GRANT_ENDS_IN_3D,
          endPeriod: END.toISOString(),
          days: '3',
        },
      },
    ]);
  });

  it('is told alone after 24 h when no time level fell due', async () => {
    const crossed = before(20);
    const { service, tx, seen } = build({ endNoticeFor: END, endNoticeAt: before(7), usageNoticeLevel: 50, usageNoticeSince: crossed });
    expect(await service.check(tx, GRANT, after(crossed, 23))).toBeNull();
    expect(await service.check(tx, GRANT, after(crossed, 24))).toBe(OutboxEventType.GRANT_USAGE_50);
    expect(seen.outbox).toEqual([
      { type: OutboxEventType.GRANT_USAGE_50, payload: { ...who, period: ACTIVE.toISOString(), percent: '50', remaining: '30 GB' } },
    ]);
  });

  it('is dropped untold once a renewal opened a new period, or the bag is spent', async () => {
    const crossed = before(20);
    const renewed = build({ usageNoticeLevel: 80, usageNoticeSince: crossed, usagePeriodStartedAt: after(crossed, 1), endNoticeFor: END, endNoticeAt: before(7) });
    expect(await renewed.service.check(renewed.tx, GRANT, after(crossed, 24))).toBeNull();
    expect(renewed.seen.writes[0]?.data).toEqual({ endNoticeFor: END, endNoticeAt: before(7), usageNoticeLevel: null, usageNoticeSince: null });
    expect(renewed.seen.outbox).toEqual([]);

    const spent = build({ usageNoticeLevel: 80, usageNoticeSince: crossed, consumedBytes: BigInt(50) * GB, endsAt: null });
    expect(await spent.service.check(spent.tx, GRANT, after(crossed, 24))).toBeNull();
    expect(spent.seen.writes[0]?.data).toEqual({ usageNoticeLevel: null, usageNoticeSince: null });
    expect(spent.seen.outbox).toEqual([]);
  });

  it('emits nothing when another sweep, a charge or a renewal moved the Grant first', async () => {
    const { service, tx, seen } = build({ usageNoticeLevel: 80, usageNoticeSince: before(20) }, { raced: true });
    expect(await service.check(tx, GRANT, before(3))).toBeNull();
    expect(seen.outbox).toEqual([]);
  });
});
