/**
 * Time thresholds — F-601-e (spec 9.5). An active Grant is told 7, 3 and 1
 * day(s) before its end, once each per end, unlimited Grants included.
 *
 * What would break silently here, and nowhere else:
 *
 *  - **the period is the end**: a renewal moves `endsAt`, and the Grant is
 *    due again at the new end's levels with no writer resetting anything —
 *    `endNoticeFor` no longer matches it;
 *  - **the latest truth, once**: a sweep late past two levels tells the lower
 *    alone, and the text carries the whole days actually left, never the
 *    level's name;
 *  - **nothing is told on purchase**: a level that fell due before the Grant
 *    was active passes untold, so a 5-day service is not "ending soon" the
 *    minute it is bought;
 *  - **each level is emitted once**: the write is conditional on the clock it
 *    read, and the event names the end as its period for notification's
 *    ledger (invariant 14).
 */
import { GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GrantEndNoticeService, endNoticeStep } from './end-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';

const END = new Date('2026-10-27T10:00:00.000Z');
const ACTIVE = new Date('2026-09-27T10:00:00.000Z');
const before = (days: number) => new Date(END.getTime() - days * 86_400_000);

describe('each check (F-601-e)', () => {
  const fresh = { endsAt: END, activeSince: ACTIVE, endNoticeFor: null, endNoticeAt: null };
  const told = (days: number, next: Date | null) => ({ ...fresh, endNoticeFor: END, endNoticeAt: next ?? before(days) });

  it('at 7 days tells it, and waits for 3', () => {
    expect(endNoticeStep(fresh, before(7))).toEqual({ notice: { type: OutboxEventType.GRANT_ENDS_IN_7D, days: 7 }, next: before(3) });
  });

  it('at 3 days tells it, and waits for 1; at 1 tells it and stops', () => {
    expect(endNoticeStep(told(3, before(3)), before(3))).toEqual({ notice: { type: OutboxEventType.GRANT_ENDS_IN_3D, days: 3 }, next: before(1) });
    expect(endNoticeStep(told(1, before(1)), before(1))).toEqual({ notice: { type: OutboxEventType.GRANT_ENDS_IN_1D, days: 1 }, next: null });
  });

  it('a sweep late past two levels tells the lower alone, with the days actually left', () => {
    expect(endNoticeStep(fresh, before(2.5))).toEqual({ notice: { type: OutboxEventType.GRANT_ENDS_IN_3D, days: 3 }, next: before(1) });
    expect(endNoticeStep(fresh, before(0.2))).toEqual({ notice: { type: OutboxEventType.GRANT_ENDS_IN_1D, days: 1 }, next: null });
  });

  it('a level already told for this end is not told again', () => {
    expect(endNoticeStep(told(3, before(3)), before(5))).toEqual({ notice: null, next: before(3) });
    expect(endNoticeStep({ ...fresh, endNoticeFor: END, endNoticeAt: null }, before(0.5))).toEqual({ notice: null, next: null });
  });

  it('a level that fell due before the Grant was active passes untold', () => {
    const fiveDays = { ...fresh, activeSince: before(5) };
    expect(endNoticeStep(fiveDays, before(5))).toEqual({ notice: null, next: before(3) });
    expect(endNoticeStep(fiveDays, before(3))).toEqual({ notice: { type: OutboxEventType.GRANT_ENDS_IN_3D, days: 3 }, next: before(1) });
  });

  it('a renewed end starts over, whatever the old one told', () => {
    const later = new Date(END.getTime() + 30 * 86_400_000);
    const renewed = { ...fresh, endsAt: later, endNoticeFor: END, endNoticeAt: null };
    const at = new Date(later.getTime() - 7 * 86_400_000);
    expect(endNoticeStep(renewed, at)).toEqual({
      notice: { type: OutboxEventType.GRANT_ENDS_IN_7D, days: 7 },
      next: new Date(later.getTime() - 3 * 86_400_000),
    });
  });

  it('a Grant past its end is told nothing', () => {
    expect(endNoticeStep(fresh, END)).toEqual({ notice: null, next: null });
  });
});

describe('the sweep writes and emits once (F-601-e)', () => {
  function build(opts: { raced?: boolean } = {}) {
    const seen = {
      writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>,
      outbox: [] as Array<{ aggregateId: string; type: string; payload: Record<string, unknown> }>,
    };
    const tx = {
      grant: {
        findFirst: async () => ({
          id: GRANT,
          tenantId: TENANT,
          userId: USER,
          startsAt: ACTIVE,
          activatedAt: ACTIVE,
          endsAt: END,
          endNoticeFor: null,
          endNoticeAt: null,
        }),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          seen.writes.push({ where, data });
          return { count: opts.raced ? 0 : 1 };
        },
      },
      outboxEvent: {
        create: async ({ data }: { data: { aggregateId: string; type: string; payload: Record<string, unknown> } }) => {
          seen.outbox.push({ aggregateId: data.aggregateId, type: data.type, payload: data.payload });
          return { id: 'e1' };
        },
      },
    };
    const service = new GrantEndNoticeService({} as never, {} as never);
    return { service, tx: tx as never as Prisma.TransactionClient, seen };
  }

  it('moves the clock conditionally on the one it read, and emits the level with the end as its period', async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, before(7))).toBe(OutboxEventType.GRANT_ENDS_IN_7D);
    expect(seen.writes).toEqual([
      {
        where: { id: GRANT, status: GrantStatus.active, endsAt: END, endNoticeFor: null, endNoticeAt: null },
        data: { endNoticeFor: END, endNoticeAt: before(3) },
      },
    ]);
    expect(seen.outbox).toEqual([
      {
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_ENDS_IN_7D,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: END.toISOString(), days: '7' },
      },
    ]);
  });

  it('emits nothing when another sweep, or a renewal, moved the Grant first', async () => {
    const { service, tx, seen } = build({ raced: true });
    expect(await service.check(tx, GRANT, before(7))).toBeNull();
    expect(seen.outbox).toEqual([]);
  });
});
