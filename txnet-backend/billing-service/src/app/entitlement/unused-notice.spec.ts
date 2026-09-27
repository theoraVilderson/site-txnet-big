/**
 * "Not connected yet?" — F-601-c (spec 9.5, beyond the catalog, user
 * 2026-09-27). An active Grant with nothing consumed 24 h and again 72 h after
 * activation is told how to connect, and where support is.
 *
 * What would break silently here, and nowhere else:
 *
 *  - **the clock starts at activation**, not at issue: a purchase waits
 *    `pending` until delivered, and a Grant carried over (`migration`,
 *    `rollover`) is never asked at all;
 *  - **one byte ends it**: a Grant that has consumed anything is never asked
 *    again, whatever stage it was at;
 *  - **two notices, then silence**: the 24 h one moves the clock to 72 h, the
 *    72 h one clears it; a sweep that was down past 72 h tells only the second;
 *  - **nothing is asked of a service that is not there yet**: with no config
 *    its panel confirmed, the stage passes untold (that is F-601-i's notice);
 *  - **each stage is emitted once**: the write is conditional on the clock it
 *    read, so two sweeps racing emit one event, and the event names the
 *    activation as its period for notification's ledger (invariant 14).
 */
import { GrantSource, GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GrantUnusedNoticeService, unusedClockOf, unusedNoticeStep } from './unused-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';

const ACTIVATED = new Date('2026-09-27T10:00:00.000Z');
const hours = (n: number) => new Date(ACTIVATED.getTime() + n * 3_600_000);

describe('the clock starts at activation (F-601-c)', () => {
  it('is 24 h after it for anything the user was given or bought', () => {
    for (const source of [GrantSource.purchase, GrantSource.admin_grant, GrantSource.coupon, GrantSource.trial, GrantSource.affiliate_reward]) {
      expect(unusedClockOf(source, ACTIVATED), source).toEqual(hours(24));
    }
  });

  it('never starts for a Grant carried over from somewhere else', () => {
    expect(unusedClockOf(GrantSource.migration, ACTIVATED)).toBeNull();
    expect(unusedClockOf(GrantSource.rollover, ACTIVATED)).toBeNull();
  });
});

describe('each check (F-601-c)', () => {
  const unused = { activatedAt: ACTIVATED, consumedBytes: BigInt(0), confirmed: true };

  it('at 24 h tells the first notice and moves the clock to 72 h', () => {
    expect(unusedNoticeStep({ ...unused, unusedCheckAt: hours(24) }, hours(24))).toEqual({
      notice: OutboxEventType.GRANT_NOT_CONNECTED,
      next: hours(72),
    });
  });

  it('at 72 h tells the second and stops', () => {
    expect(unusedNoticeStep({ ...unused, unusedCheckAt: hours(72) }, hours(72))).toEqual({
      notice: OutboxEventType.GRANT_STILL_NOT_CONNECTED,
      next: null,
    });
  });

  it('a sweep that was down past 72 h tells only the second', () => {
    expect(unusedNoticeStep({ ...unused, unusedCheckAt: hours(24) }, hours(80))).toEqual({
      notice: OutboxEventType.GRANT_STILL_NOT_CONNECTED,
      next: null,
    });
  });

  it('one consumed byte ends it, at either stage', () => {
    for (const at of [hours(24), hours(72)]) {
      expect(unusedNoticeStep({ ...unused, consumedBytes: BigInt(1), unusedCheckAt: at }, at)).toEqual({ notice: null, next: null });
    }
  });

  it('with no config confirmed on a panel, the stage passes untold', () => {
    expect(unusedNoticeStep({ ...unused, confirmed: false, unusedCheckAt: hours(24) }, hours(24))).toEqual({ notice: null, next: hours(72) });
    expect(unusedNoticeStep({ ...unused, confirmed: false, unusedCheckAt: hours(72) }, hours(72))).toEqual({ notice: null, next: null });
  });

  it('a Grant with no activation instant is never told', () => {
    expect(unusedNoticeStep({ ...unused, activatedAt: null, unusedCheckAt: hours(24) }, hours(24))).toEqual({ notice: null, next: null });
  });
});

describe('the sweep writes and emits once (F-601-c)', () => {
  function build(opts: { consumed?: bigint; confirmed?: boolean; clock?: Date; raced?: boolean; supportUrl?: string | null } = {}) {
    const clock = opts.clock ?? hours(24);
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
          activatedAt: ACTIVATED,
          unusedCheckAt: clock,
          consumedBytes: opts.consumed ?? BigInt(0),
          configs: opts.confirmed === false ? [] : [{ id: 'c1' }],
        }),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          seen.writes.push({ where, data });
          return { count: opts.raced ? 0 : 1 };
        },
      },
      tenantBranding: { findUnique: async () => (opts.supportUrl === null ? null : { supportUrl: opts.supportUrl ?? 'https://t.me/support' }) },
      outboxEvent: {
        create: async ({ data }: { data: { aggregateId: string; type: string; payload: Record<string, unknown> } }) => {
          seen.outbox.push({ aggregateId: data.aggregateId, type: data.type, payload: data.payload });
          return { id: 'e1' };
        },
      },
    };
    const service = new GrantUnusedNoticeService({} as never, {} as never);
    return { service, tx: tx as never as Prisma.TransactionClient, seen };
  }

  it('moves the clock conditionally on the one it read, and emits the notice with the activation as its period', async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, hours(24))).toBe(OutboxEventType.GRANT_NOT_CONNECTED);
    expect(seen.writes).toEqual([
      { where: { id: GRANT, status: GrantStatus.active, unusedCheckAt: hours(24) }, data: { unusedCheckAt: hours(72) } },
    ]);
    expect(seen.outbox).toEqual([
      {
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_NOT_CONNECTED,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: ACTIVATED.toISOString(), supportUrl: 'https://t.me/support' },
      },
    ]);
  });

  it('names no support link the tenant has not set', async () => {
    const { service, tx, seen } = build({ supportUrl: null });
    await service.check(tx, GRANT, hours(24));
    expect(seen.outbox[0]?.payload).not.toHaveProperty('supportUrl');
  });

  it('emits nothing when another sweep moved the clock first', async () => {
    const { service, tx, seen } = build({ raced: true });
    expect(await service.check(tx, GRANT, hours(24))).toBeNull();
    expect(seen.outbox).toEqual([]);
  });

  it('a used Grant has its clock cleared and nobody told', async () => {
    const { service, tx, seen } = build({ consumed: BigInt(4096) });
    expect(await service.check(tx, GRANT, hours(24))).toBeNull();
    expect(seen.writes[0]?.data).toEqual({ unusedCheckAt: null });
    expect(seen.outbox).toEqual([]);
  });
});
