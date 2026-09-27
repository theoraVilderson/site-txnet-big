/**
 * "Your service is active again" (F-601-k, beyond the catalog) — told where a
 * stop is undone: a renewal or a top-up reviving a suspended Grant, or a
 * renewal breaking the close that stood on an active one (an unlimited or
 * metered Grant past its end, which nothing suspends; `network/contract.lease.md`
 * rule 25). Never where the service stays off: a debt still eating the bag, an
 * end still passed, or a close the renewal did not break.
 */
import { GrantSource, GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { renewGrant } from './renewal';
import { reviveFundedGrants } from './revival';
import { QUOTA_EXHAUSTED } from './suspension';

const GIB = BigInt(1024 ** 3);
const DAY_MS = 86_400_000;
const GRANT = '99999999-9999-4999-8999-999999999991';
const TENANT = '77777777-7777-4777-8777-777777777771';
const USER = '88888888-8888-4888-8888-888888888881';
const AT = new Date('2026-09-27T12:00:00Z');
const PAST_END = new Date(AT.getTime() - DAY_MS);
const SUSPENDED_AT = new Date(AT.getTime() - 2 * DAY_MS);
const CLOSED_AT = new Date(AT.getTime() - DAY_MS + 60_000);

type Row = {
  status: GrantStatus;
  statusReason: string | null;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  endsAt: Date | null;
  suspendedAt: Date | null;
};
type Close = { quotaBytes: bigint; expiresAt: Date | null; closedAt: Date };

function build(row: Partial<Row>, opts: { usedBytes?: bigint; close?: Close | null } = {}) {
  const grant = {
    id: GRANT,
    tenantId: TENANT,
    userId: USER,
    status: GrantStatus.active,
    statusReason: null,
    billingMode: VariantBillingMode.prepaid,
    trafficUnlimited: false,
    purchasedBytes: BigInt(10) * GIB,
    endsAt: new Date(AT.getTime() + 3 * DAY_MS),
    suspendedAt: null,
    consumedBytes: BigInt(0),
    meteredRate: new Prisma.Decimal('1.00'),
    ...row,
  };
  const used = opts.usedBytes ?? BigInt(0);
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const tx = {
    grant: {
      findUnique: async () => grant,
      findMany: async () => [grant],
      updateMany: async () => ({ count: 1 }),
    },
    config: {
      findMany: async () => [{ counterState: { lifetimeUpBytes: used, lifetimeDownBytes: BigInt(0) } }],
      updateMany: async () => ({ count: 1 }),
    },
    leaseClose: { findUnique: async () => opts.close ?? null },
    quotaAdjustment: { create: async ({ data }: { data: unknown }) => data },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
        events.push(data);
        return { id: 'e' };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, events };
}

const renew = (tx: Prisma.TransactionClient, bytes: bigint, days: number) =>
  renewGrant(tx, { grantId: GRANT, bytes, days, source: GrantSource.purchase, at: AT });

type Event = { type: string; payload: Record<string, unknown> };
const told = (events: Event[]) => events.filter((e) => e.type === OutboxEventType.GRANT_REACTIVATED);

describe('F-601-k: a renewal that brings a stopped Grant back tells its owner', () => {
  it('a prepaid Grant suspended for its spent bag, renewed with room: told once, period = the suspension', async () => {
    const { tx, events } = build(
      { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT },
      { usedBytes: BigInt(10) * GIB },
    );
    expect((await renew(tx, BigInt(10) * GIB, 30)).revived).toBe(true);
    expect(told(events)).toEqual([
      {
        aggregate: 'entitlement.grant',
        aggregateId: GRANT,
        type: OutboxEventType.GRANT_REACTIVATED,
        payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: SUSPENDED_AT.toISOString() },
      },
    ]);
  });

  it('a prepaid Grant suspended on its end, renewed by days alone with bytes left: told', async () => {
    const { tx, events } = build(
      { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT, endsAt: PAST_END },
      { usedBytes: BigInt(4) * GIB },
    );
    await renew(tx, BigInt(0), 30);
    expect(told(events)).toHaveLength(1);
  });

  it('a renewal whose carried debt still eats the bag revives nothing and tells nothing', async () => {
    const { tx, events } = build(
      { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT },
      { usedBytes: BigInt(25) * GIB },
    );
    expect((await renew(tx, BigInt(10) * GIB, 30)).revived).toBe(false);
    expect(told(events)).toEqual([]);
  });

  it('bytes alone on a Grant whose end has passed: revived, but still off — untold', async () => {
    const { tx, events } = build(
      { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT, endsAt: PAST_END },
      { usedBytes: BigInt(10) * GIB },
    );
    await renew(tx, BigInt(10) * GIB, 0);
    expect(told(events)).toEqual([]);
  });

  it('an unlimited Grant closed on its passed end, renewed by days: told, period = the close', async () => {
    const { tx, events } = build(
      { trafficUnlimited: true, purchasedBytes: BigInt(0), endsAt: PAST_END },
      { close: { quotaBytes: BigInt(0), expiresAt: PAST_END, closedAt: CLOSED_AT } },
    );
    await renew(tx, BigInt(0), 30);
    expect(told(events).map((e) => e.payload['period'])).toEqual([CLOSED_AT.toISOString()]);
  });

  it('a metered Grant closed on its passed end, renewed by days: told', async () => {
    const { tx, events } = build(
      { billingMode: VariantBillingMode.metered, endsAt: PAST_END },
      { close: { quotaBytes: BigInt(10) * GIB, expiresAt: PAST_END, closedAt: CLOSED_AT } },
    );
    await renew(tx, BigInt(0), 30);
    expect(told(events)).toHaveLength(1);
  });

  it('a metered Grant closed on its bag, not its end: a renewal of days does not reopen it — untold', async () => {
    const future = new Date(AT.getTime() + 3 * DAY_MS);
    const { tx, events } = build(
      { billingMode: VariantBillingMode.metered, endsAt: future },
      { close: { quotaBytes: BigInt(10) * GIB, expiresAt: future, closedAt: CLOSED_AT } },
    );
    await renew(tx, BigInt(0), 30);
    expect(told(events)).toEqual([]);
  });

  it('an active Grant with no close, or a close on another end, was never stopped: untold', async () => {
    const running = build({ trafficUnlimited: true, purchasedBytes: BigInt(0) });
    await renew(running.tx, BigInt(0), 30);
    const stale = build(
      { trafficUnlimited: true, purchasedBytes: BigInt(0), endsAt: PAST_END },
      { close: { quotaBytes: BigInt(0), expiresAt: SUSPENDED_AT, closedAt: CLOSED_AT } },
    );
    await renew(stale.tx, BigInt(0), 30);
    expect([...told(running.events), ...told(stale.events)]).toEqual([]);
  });

  it('a prepaid Grant still active on a standing close (suspension not yet seen), renewed with room: told', async () => {
    const { tx, events } = build(
      {},
      { usedBytes: BigInt(10) * GIB, close: { quotaBytes: BigInt(10) * GIB, expiresAt: new Date(AT.getTime() + 3 * DAY_MS), closedAt: CLOSED_AT } },
    );
    await renew(tx, BigInt(10) * GIB, 0);
    expect(told(events)).toHaveLength(1);
  });
});

describe('F-601-k: a top-up that revives a metered Grant tells its owner', () => {
  it('told once per revived Grant, period = the suspension', async () => {
    const { tx, events } = build({
      status: GrantStatus.suspended,
      statusReason: QUOTA_EXHAUSTED,
      billingMode: VariantBillingMode.metered,
      suspendedAt: SUSPENDED_AT,
    });
    expect((await reviveFundedGrants(tx, USER, new Prisma.Decimal('5.00'), AT)).revived).toBe(1);
    expect(told(events).map((e) => e.payload['period'])).toEqual([SUSPENDED_AT.toISOString()]);
  });

  it('a revived Grant whose end has passed is still off: untold', async () => {
    const { tx, events } = build({
      status: GrantStatus.suspended,
      statusReason: QUOTA_EXHAUSTED,
      billingMode: VariantBillingMode.metered,
      suspendedAt: SUSPENDED_AT,
      endsAt: PAST_END,
    });
    await reviveFundedGrants(tx, USER, new Prisma.Decimal('5.00'), AT);
    expect(told(events)).toEqual([]);
  });
});
