/**
 * An admin resets a prepaid Grant's traffic (F-311-k, spec F-311): the full
 * bag is left again. What would break quietly here, and nowhere else:
 *
 *  - **the meter is never rewritten** (user, 2026-09-26): Quota rises by what
 *    was consumed, as one `quota_adjustment` row beside `purchasedBytes`
 *    (invariant 3); `consumedBytes` and the lifetime counters stay as they are,
 *    so usage history and billing evidence survive;
 *  - **"consumed" is since the last reset** (`trafficResetFromBytes`): a second
 *    reset that re-added the first one's bytes would leave more than the full
 *    bag, and every later one more again;
 *  - **a reset opens a usage period**, as a renewal's bytes do (F-601-d): the
 *    50 / 80 / 95 % levels are a share of the bag it leaves, told again;
 *  - **a reset revives a Grant suspended for quota** — a frozen one stays frozen;
 *  - **the write is conditional on the Quota, the cursor and the status read**:
 *    two resets racing would each add the same bytes.
 */
import { GrantSource, GrantStatus, QuotaMetric, VariantBillingMode } from '@prisma/client';

import { ADMIN_FROZEN } from './freeze';
import { EntitlementRefused } from './grant';
import { QUOTA_EXHAUSTED } from './suspension';
import { resetGrantTraffic } from './traffic';

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
  trafficResetFromBytes: bigint;
  consumedBytes: bigint;
  usagePeriodFromBytes: bigint;
  usagePeriodStartedAt: Date | null;
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
        trafficResetFromBytes: BigInt(0),
        consumedBytes: used,
        usagePeriodFromBytes: BigInt(0),
        usagePeriodStartedAt: null,
        endsAt: new Date(AT.getTime() + 10 * DAY),
        ...row,
      }
    : null;
  const counters = { used };
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
      findMany: async () => [
        { counterState: { lifetimeUpBytes: counters.used / BigInt(4), lifetimeDownBytes: counters.used - counters.used / BigInt(4) } },
        { counterState: null },
      ],
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        configWrites.push(data);
        return { count: 2 };
      },
    },
    grantWholesale: { findUnique: async () => null },
    quotaAdjustment: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        adjustments.push(data);
        return { id: `adjustment-${adjustments.length}` };
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
  return { tx: tx as never, grant, counters, writes, adjustments, events, configWrites };
}

const reset = (at = AT, reason = 'support ticket 42') => ({ at, actorUserId: ADMIN, reason });

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => (e instanceof EntitlementRefused ? e.reason : e),
  );

describe('resetGrantTraffic (F-311-k)', () => {
  it('raises Quota by what was used, with one admin row, and leaves the meter alone', async () => {
    const { tx, grant, writes, adjustments } = build({});

    const done = await resetGrantTraffic(tx, GRANT, reset());

    expect(done).toEqual({
      adjustmentId: 'adjustment-1',
      purchasedBytesBefore: BigInt(10) * GIB,
      purchasedBytesAfter: BigInt(13) * GIB,
      usedBytes: BigInt(3) * GIB,
      resetBytes: BigInt(3) * GIB,
      spent: false,
      revived: false,
      reactivated: false,
    });
    // The full bag is left again: Quota - Used is the 10 GiB it started with.
    expect(grant?.purchasedBytes).toBe(BigInt(13) * GIB);
    expect(grant?.trafficResetFromBytes).toBe(BigInt(3) * GIB);
    // The meter is never zeroed.
    expect(grant?.consumedBytes).toBe(BigInt(3) * GIB);
    expect(writes[0].where).toEqual({
      id: GRANT,
      status: GrantStatus.active,
      purchasedBytes: BigInt(10) * GIB,
      trafficResetFromBytes: BigInt(0),
    });
    expect(adjustments).toEqual([
      {
        tenantId: TENANT,
        grantId: GRANT,
        metric: QuotaMetric.traffic_bytes,
        delta: BigInt(3) * GIB,
        source: GrantSource.admin_grant,
        reason: 'support ticket 42',
        createdByAdminId: ADMIN,
      },
    ]);
  });

  it('opens a usage period at the reset, so the usage levels are told again', async () => {
    const { tx, grant } = build({ consumedBytes: BigInt(3) * GIB + BigInt(7) });

    await resetGrantTraffic(tx, GRANT, reset());

    expect(grant?.usagePeriodFromBytes).toBe(BigInt(3) * GIB + BigInt(7));
    expect(grant?.usagePeriodStartedAt).toEqual(AT);
  });

  it('adds only what was used since the last reset, so a second one leaves the full bag, not more', async () => {
    const { tx, grant, counters, adjustments } = build({});
    await resetGrantTraffic(tx, GRANT, reset());

    counters.used = BigInt(8) * GIB;
    const done = await resetGrantTraffic(tx, GRANT, reset(new Date(AT.getTime() + DAY)));

    expect(done.resetBytes).toBe(BigInt(5) * GIB);
    expect(adjustments.map((a) => a.delta)).toEqual([BigInt(3) * GIB, BigInt(5) * GIB]);
    expect((grant?.purchasedBytes ?? BigInt(0)) - counters.used).toBe(BigInt(10) * GIB);
    expect(grant?.trafficResetFromBytes).toBe(BigInt(8) * GIB);
  });

  it('revives a Grant suspended for quota, and says so', async () => {
    const { tx, grant, events, configWrites } = build(
      { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT },
      BigInt(11) * GIB,
    );

    const done = await resetGrantTraffic(tx, GRANT, reset());

    expect(done).toMatchObject({ revived: true, spent: false, purchasedBytesAfter: BigInt(21) * GIB });
    expect(grant?.status).toBe(GrantStatus.active);
    expect(configWrites).toHaveLength(1);
    // F-311-s: reported, and told inside the admin's own notice — never a second "active again".
    expect(done.reactivated).toBe(true);
    expect(events).toEqual([]);
  });

  it('resets a frozen Grant and leaves it frozen', async () => {
    const { tx, grant, events } = build({ status: GrantStatus.suspended, statusReason: ADMIN_FROZEN, suspendedAt: SUSPENDED_AT });

    const done = await resetGrantTraffic(tx, GRANT, reset());

    expect(done).toMatchObject({ revived: false, purchasedBytesAfter: BigInt(13) * GIB });
    expect(grant?.status).toBe(GrantStatus.suspended);
    expect(grant?.statusReason).toBe(ADMIN_FROZEN);
    expect(events).toEqual([]);
  });

  it('refuses a reset with nothing used since the last one, and writes nothing', async () => {
    const { tx, writes, adjustments } = build({ trafficResetFromBytes: BigInt(3) * GIB });

    expect(await refusal(resetGrantTraffic(tx, GRANT, reset()))).toBe('nothing_to_reset');
    expect(writes).toEqual([]);
    expect(adjustments).toEqual([]);
  });

  it.each([
    ['metered', { billingMode: VariantBillingMode.metered }, 'traffic_not_adjustable'],
    ['unlimited', { trafficUnlimited: true, purchasedBytes: BigInt(0) }, 'traffic_not_adjustable'],
    ['expired', { status: GrantStatus.expired }, 'grant_closed'],
    ['pending', { status: GrantStatus.pending }, 'grant_not_active'],
  ] as const)('refuses a %s Grant', async (_, row, reason) => {
    const { tx, adjustments } = build(row);

    expect(await refusal(resetGrantTraffic(tx, GRANT, reset()))).toBe(reason);
    expect(adjustments).toEqual([]);
  });

  it('answers a missing Grant as grant_not_found', async () => {
    const { tx } = build(null);

    expect(await refusal(resetGrantTraffic(tx, GRANT, reset()))).toBe('grant_not_found');
  });

  it('is grant_moved when the Quota or the cursor changed since the read, and writes no row', async () => {
    const { tx, grant, adjustments } = build({});
    const read = tx as unknown as { grant: { findUnique: (a: unknown) => Promise<Row> } };
    const original = read.grant.findUnique;
    read.grant.findUnique = async (a) => {
      const seen = await original(a);
      (grant as Row).trafficResetFromBytes = BigInt(1);
      return seen;
    };

    expect(await refusal(resetGrantTraffic(tx, GRANT, reset()))).toBe('grant_moved');
    expect(adjustments).toEqual([]);
  });
});
