/**
 * "Trouble connecting?" — F-601-l (spec 9.5, beyond the catalog). An active
 * Grant that was used, and then consumed nothing for 7 days, is checked in on
 * once per idle stretch.
 *
 * What would break silently here, and nowhere else:
 *
 *  - **one ask per stretch**: the check clears the clock; only the next
 *    consumed byte (metering's charge) sets it again, so a Grant idle for a
 *    month hears once, and a Grant used again hears again after its next 7 days;
 *  - **never a Grant that cannot run**: past its end, under a standing close,
 *    or a spent bag — it is idle because it stopped, and the cutoff notice
 *    (F-601-b) is that Grant's; nor one with no config confirmed on a panel;
 *    the stretch passes untold and the clock is still cleared;
 *  - **each stretch is emitted once**: the write is conditional on the clock
 *    read — a charge or a second sweep between read and write emits nothing —
 *    and the event names the clock as its period for notification's ledger.
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType, idleCheckOf } from '@txnet-backend/shared-core';

import { GrantIdleNoticeService, idleNoticeTold } from './idle-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';

const LAST_USE = new Date('2026-09-20T10:00:00.000Z');
const DUE = idleCheckOf(LAST_USE);
const days = (n: number) => new Date(LAST_USE.getTime() + n * 86_400_000);

describe('the clock (F-601-l)', () => {
  it('is 7 days after the last charge that consumed a byte', () => {
    expect(DUE).toEqual(days(7));
  });
});

describe('who is asked (F-601-l)', () => {
  const idle = { endsAt: days(30), bagSpent: false, closed: false, confirmed: true };

  it('an idle Grant that can run, on a confirmed config', () => {
    expect(idleNoticeTold(idle, DUE)).toBe(true);
    expect(idleNoticeTold({ ...idle, endsAt: null }, DUE)).toBe(true);
  });

  it('never one past its end, under a standing close, or with its bag spent', () => {
    expect(idleNoticeTold({ ...idle, endsAt: days(6) }, DUE)).toBe(false);
    expect(idleNoticeTold({ ...idle, endsAt: DUE }, DUE)).toBe(false);
    expect(idleNoticeTold({ ...idle, closed: true }, DUE)).toBe(false);
    expect(idleNoticeTold({ ...idle, bagSpent: true }, DUE)).toBe(false);
  });

  it('never one with no config confirmed on a panel', () => {
    expect(idleNoticeTold({ ...idle, confirmed: false }, DUE)).toBe(false);
  });
});

describe('the sweep writes and emits once (F-601-l)', () => {
  function build(
    opts: { raced?: boolean; supportUrl?: string | null; consumed?: bigint; purchased?: bigint; unlimited?: boolean; close?: Record<string, unknown> | null } = {},
  ) {
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
          idleCheckAt: DUE,
          endsAt: days(30),
          billingMode: VariantBillingMode.prepaid,
          trafficUnlimited: opts.unlimited ?? false,
          purchasedBytes: opts.purchased ?? BigInt(10) * BigInt(2 ** 30),
          consumedBytes: opts.consumed ?? BigInt(2 ** 30),
          configs: [{ id: 'c1' }],
        }),
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          seen.writes.push({ where, data });
          return { count: opts.raced ? 0 : 1 };
        },
      },
      leaseClose: { findUnique: async () => opts.close ?? null },
      tenantBranding: { findUnique: async () => (opts.supportUrl === null ? null : { supportUrl: opts.supportUrl ?? 'https://t.me/support' }) },
      outboxEvent: {
        create: async ({ data }: { data: { aggregateId: string; type: string; payload: Record<string, unknown> } }) => {
          seen.outbox.push({ aggregateId: data.aggregateId, type: data.type, payload: data.payload });
          return { id: 'e1' };
        },
      },
    };
    const service = new GrantIdleNoticeService({} as never, {} as never);
    return { service, tx: tx as never as Prisma.TransactionClient, seen };
  }

  it('clears the clock conditionally on the one it read, and emits the check-in with the clock as its period', async () => {
    const { service, tx, seen } = build();
    expect(await service.check(tx, GRANT, DUE)).toBe(true);
    expect(seen.writes).toEqual([{ where: { id: GRANT, status: GrantStatus.active, idleCheckAt: DUE }, data: { idleCheckAt: null } }]);
    expect(seen.outbox).toEqual([
      {
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_IDLE,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: DUE.toISOString(), supportUrl: 'https://t.me/support' },
      },
    ]);
  });

  it('names no support link the tenant has not set', async () => {
    const { service, tx, seen } = build({ supportUrl: null });
    await service.check(tx, GRANT, DUE);
    expect(seen.outbox[0]?.payload).not.toHaveProperty('supportUrl');
  });

  it('emits nothing when a charge or another sweep moved the clock first', async () => {
    const { service, tx, seen } = build({ raced: true });
    expect(await service.check(tx, GRANT, DUE)).toBe(false);
    expect(seen.outbox).toEqual([]);
  });

  it('a spent bag clears the clock untold; an unlimited Grant has no bag to spend', async () => {
    const spent = build({ consumed: BigInt(2 ** 30), purchased: BigInt(2 ** 30) });
    expect(await spent.service.check(spent.tx, GRANT, DUE)).toBe(false);
    expect(spent.seen.writes[0]?.data).toEqual({ idleCheckAt: null });
    expect(spent.seen.outbox).toEqual([]);

    const unlimited = build({ unlimited: true, purchased: BigInt(0) });
    expect(await unlimited.service.check(unlimited.tx, GRANT, DUE)).toBe(true);
  });

  it('a close standing on the Grant clears the clock untold', async () => {
    const { service, tx, seen } = build({ close: { quotaBytes: BigInt(10) * BigInt(2 ** 30), expiresAt: days(30), closedAt: days(2) } });
    expect(await service.check(tx, GRANT, DUE)).toBe(false);
    expect(seen.writes[0]?.data).toEqual({ idleCheckAt: null });
    expect(seen.outbox).toEqual([]);
  });
});
