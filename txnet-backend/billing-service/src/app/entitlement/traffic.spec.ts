/**
 * An admin changes a prepaid Grant's traffic by hand (F-311-j, spec F-311):
 * ±bytes on its Quota, written down. What would break quietly here, and
 * nowhere else:
 *
 *  - **Quota is `purchasedBytes`**, the figure the lease planner splits into
 *    ceilings every pass (`network/contract.lease.md` rule 1). A
 *    `quota_adjustment` row alone moves no ceiling: the column and the row move
 *    together, or the change did not happen (invariant 3);
 *  - **a cut below Used is written, not refused, and not suspended here**: the
 *    planner's close is the one rule for "spent" (ADR-0096), so it closes the
 *    Grant on its next pass and billing suspends it as exhausted from there;
 *  - **a raise that leaves room revives a Grant suspended for quota** — and only
 *    that one: a frozen Grant stays frozen;
 *  - **only a prepaid, limited Grant** has a bag an admin can move: a metered
 *    one's is bought by its blocks, an unlimited one has none;
 *  - **the write is conditional on the Quota and status read** — a renewal in
 *    between is `grant_moved`, never a change applied to a figure nobody saw.
 */
import { GrantSource, GrantStatus, QuotaMetric, VariantBillingMode } from '@prisma/client';

import { ADMIN_FROZEN } from './freeze';
import { EntitlementRefused } from './grant';
import { QUOTA_EXHAUSTED } from './suspension';
import { adjustGrantTraffic } from './traffic';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const GRANT = '99999999-9999-4999-8999-999999999991';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const GIB = BigInt(1024 ** 3);
const DAY = 86_400_000;
const AT = new Date('2026-09-28T10:00:00.000Z');
const SUSPENDED_AT = new Date(AT.getTime() - DAY);

type Row = {
  id: string;
  tenantId: string;
  userId: string;
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  endsAt: Date | null;
};

/** `used` is Σ lifetime counters of the Grant's configs, as the planner sums it. */
function build(row: Partial<Row> | null, used = BigInt(3) * GIB) {
  const grant: Row | null = row
    ? {
        id: GRANT,
        tenantId: TENANT,
        userId: USER,
        status: GrantStatus.active,
        statusReason: null,
        suspendedAt: null,
        billingMode: VariantBillingMode.prepaid,
        trafficUnlimited: false,
        purchasedBytes: BigInt(10) * GIB,
        endsAt: new Date(AT.getTime() + 10 * DAY),
        ...row,
      }
    : null;
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const adjustments: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const configWrites: Array<Record<string, unknown>> = [];
  const matches = (where: Record<string, unknown>) =>
    grant !== null && Object.entries(where).every(([k, v]) => (grant as Record<string, unknown>)[k] === v);
  const tx = {
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (grant && where.id === grant.id ? { ...grant } : null),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push({ where, data });
        if (!matches(where)) return { count: 0 };
        Object.assign(grant as Row, data);
        return { count: 1 };
      },
    },
    config: {
      findMany: async () => [{ counterState: { lifetimeUpBytes: used / BigInt(4), lifetimeDownBytes: used - used / BigInt(4) } }, { counterState: null }],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        configWrites.push(data);
        return { count: 2 };
      },
    },
    grantWholesale: { findUnique: async () => null },
    quotaAdjustment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        adjustments.push(data);
        return { id: 'adjustment-1' };
      },
    },
    leaseClose: { findUnique: async () => null },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: 'event-1' };
      },
    },
  };
  return { tx: tx as never, grant, writes, adjustments, events, configWrites };
}

const move = (deltaBytes: bigint, reason = 'support ticket 42') => ({ at: AT, actorUserId: ADMIN, deltaBytes, reason });

describe('adjustGrantTraffic (F-311-j)', () => {
  it('raises Quota and writes one admin adjustment row beside it', async () => {
    const { tx, grant, writes, adjustments } = build({});

    const done = await adjustGrantTraffic(tx, GRANT, move(BigInt(5) * GIB));

    expect(done).toEqual({
      adjustmentId: 'adjustment-1',
      purchasedBytesBefore: BigInt(10) * GIB,
      purchasedBytesAfter: BigInt(15) * GIB,
      usedBytes: BigInt(3) * GIB,
      spent: false,
      revived: false,
      reactivated: false,
    });
    expect(grant?.purchasedBytes).toBe(BigInt(15) * GIB);
    // Conditional on what was read: a renewal in between is not overwritten.
    expect(writes[0].where).toEqual({ id: GRANT, status: GrantStatus.active, purchasedBytes: BigInt(10) * GIB });
    expect(adjustments).toEqual([
      {
        tenantId: TENANT,
        grantId: GRANT,
        metric: QuotaMetric.traffic_bytes,
        delta: BigInt(5) * GIB,
        source: GrantSource.admin_grant,
        reason: 'support ticket 42',
        createdByAdminId: ADMIN,
      },
    ]);
  });

  it('cuts Quota with a negative row, and the Grant runs on while room is left', async () => {
    const { tx, grant, adjustments } = build({});

    const done = await adjustGrantTraffic(tx, GRANT, move(-(BigInt(4) * GIB)));

    expect(done.purchasedBytesAfter).toBe(BigInt(6) * GIB);
    expect(done.spent).toBe(false);
    expect(adjustments[0].delta).toBe(-(BigInt(4) * GIB));
    expect(grant?.status).toBe(GrantStatus.active);
  });

  it('writes a cut below Used and leaves the suspension to the planner close (ADR-0096)', async () => {
    const { tx, grant, configWrites } = build({});

    const done = await adjustGrantTraffic(tx, GRANT, move(-(BigInt(8) * GIB)));

    expect(done.purchasedBytesAfter).toBe(BigInt(2) * GIB);
    expect(done.spent).toBe(true);
    // Not suspended here: the close on the new Quota is the one rule for spent.
    expect(grant?.status).toBe(GrantStatus.active);
    expect(configWrites).toEqual([]);
  });

  it('revives a Grant suspended for quota when the raise leaves room, and says so', async () => {
    const { tx, grant, events, configWrites } = build({
      status: GrantStatus.suspended,
      statusReason: QUOTA_EXHAUSTED,
      suspendedAt: SUSPENDED_AT,
      purchasedBytes: BigInt(3) * GIB,
    });

    const done = await adjustGrantTraffic(tx, GRANT, move(BigInt(2) * GIB));

    expect(done.revived).toBe(true);
    expect(grant?.status).toBe(GrantStatus.active);
    expect(configWrites).toHaveLength(1);
    // F-311-s: reported, and told inside the admin's own notice — never a second "active again".
    expect(done.reactivated).toBe(true);
    expect(events).toEqual([]);
  });

  it('does not revive a raise that still leaves the bag spent', async () => {
    const { tx, grant, events } = build(
      { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT, purchasedBytes: BigInt(3) * GIB },
      BigInt(6) * GIB,
    );

    const done = await adjustGrantTraffic(tx, GRANT, move(BigInt(2) * GIB));

    expect(done).toMatchObject({ revived: false, spent: true, purchasedBytesAfter: BigInt(5) * GIB });
    expect(grant?.status).toBe(GrantStatus.suspended);
    expect(events).toEqual([]);
  });

  it('moves a frozen Grant\'s Quota and leaves it frozen', async () => {
    const { tx, grant } = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: SUSPENDED_AT });

    const done = await adjustGrantTraffic(tx, GRANT, move(BigInt(1) * GIB));

    expect(done.revived).toBe(false);
    expect(grant).toMatchObject({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, purchasedBytes: BigInt(11) * GIB });
  });

  it.each([
    ['metered', { billingMode: VariantBillingMode.metered }],
    ['unlimited', { trafficUnlimited: true, purchasedBytes: BigInt(0) }],
  ])('refuses a %s Grant: it has no bag an admin moves', async (_, row) => {
    const { tx, adjustments } = build(row);
    await expect(adjustGrantTraffic(tx, GRANT, move(GIB))).rejects.toMatchObject({ reason: 'traffic_not_adjustable' });
    expect(adjustments).toEqual([]);
  });

  it('refuses a cut below zero', async () => {
    const { tx, adjustments } = build({});
    await expect(adjustGrantTraffic(tx, GRANT, move(-(BigInt(11) * GIB)))).rejects.toMatchObject({ reason: 'quota_below_zero' });
    expect(adjustments).toEqual([]);
  });

  it.each([
    [GrantStatus.expired, 'grant_closed'],
    [GrantStatus.exhausted, 'grant_closed'],
    [GrantStatus.cancelled, 'grant_closed'],
    [GrantStatus.pending, 'grant_not_active'],
  ])('refuses a %s Grant as %s', async (status, reason) => {
    const { tx } = build({ status });
    await expect(adjustGrantTraffic(tx, GRANT, move(GIB))).rejects.toMatchObject({ reason });
  });

  it('answers a missing Grant as grant_not_found', async () => {
    const { tx } = build(null);
    const refusal = await adjustGrantTraffic(tx, GRANT, move(GIB)).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(EntitlementRefused);
    expect(refusal).toMatchObject({ reason: 'grant_not_found' });
  });

  it('is grant_moved when the Quota changed since the read, and writes no row', async () => {
    const { tx, grant, adjustments } = build({});
    const read = (tx as { grant: { findUnique: (a: unknown) => Promise<Row | null> } }).grant.findUnique;
    (tx as { grant: { findUnique: unknown } }).grant.findUnique = async (a: unknown) => {
      const seen = await read(a);
      (grant as Row).purchasedBytes += GIB; // a renewal commits in between
      return seen;
    };

    await expect(adjustGrantTraffic(tx, GRANT, move(GIB))).rejects.toMatchObject({ reason: 'grant_moved' });
    expect(adjustments).toEqual([]);
  });

  it('refuses a zero change outright', async () => {
    const { tx } = build({});
    await expect(adjustGrantTraffic(tx, GRANT, move(BigInt(0)))).rejects.toThrow(RangeError);
  });
});
