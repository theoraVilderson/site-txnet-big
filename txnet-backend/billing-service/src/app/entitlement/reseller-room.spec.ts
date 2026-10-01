/**
 * What a reseller's users and admins may add on the platform's things
 * (ADR-0106): open services on platform panels (F-019-o) and services issued
 * by hand in any 30 days (F-019-p).
 *
 * What breaks without anyone seeing it:
 *  - **a reseller filling the platform's panels.** One more open service on a
 *    platform panel past the limit is refused, counted under a per-reseller
 *    lock so two sales at once cannot both see room for one;
 *  - **the reseller's own panels counted.** A variant whose group holds no
 *    platform panel is neither counted nor refused;
 *  - **free services by the hundred.** Issued-by-hand counts the last 30
 *    days, whoever issued them, and refuses the reseller's own people;
 *  - **the platform bounded.** Its own tenant has no limits; its staff pass.
 */
import { GrantSource, GrantStatus } from '@prisma/client';
import { ResellerLimitReached, runWithTenant } from '@txnet-backend/shared-core';

import { assertAdminIssueRoom, assertPlatformGrantRoom, assertPlatformTrafficRoom } from './reseller-room';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '11111111-1111-4111-8111-111111111111';
const VARIANT = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-10-01T12:00:00Z');

function fakeTx(opts: { platformPanel?: boolean; limits?: Record<string, number | null>; count?: number; tenantType?: string; bytes?: { up: bigint; down: bigint } }) {
  const calls: string[] = [];
  let counted: Record<string, unknown> | undefined;
  let summed: Record<string, unknown> | undefined;
  const tx = {
    $executeRaw: vi.fn(async () => (calls.push('lock'), 1)),
    productVariant: { findUnique: async () => ({ panelGroupId: 'g1' }) },
    panelGroupMember: { findFirst: async () => (opts.platformPanel === false ? null : { panelId: 'p1' }) },
    tenant: { findUnique: async () => ({ tenantType: opts.tenantType ?? 'reseller' }) },
    tenantSubscription: { findUnique: async () => null },
    resellerLimit: { findMany: async () => [] },
    packageLimit: { findMany: async () => [] },
    resellerLimitSetting: { findMany: async () => Object.entries(opts.limits ?? {}).map(([key, value]) => ({ key, value })) },
    trafficDailyAggregate: {
      aggregate: async (args: { where: Record<string, unknown> }) => {
        calls.push('traffic');
        summed = args.where;
        return { _sum: { totalUploadBytes: opts.bytes?.up ?? null, totalDownloadBytes: opts.bytes?.down ?? null } };
      },
    },
    grant: {
      count: async (args: { where: Record<string, unknown> }) => {
        calls.push('count');
        counted = args.where;
        return opts.count ?? 0;
      },
    },
  };
  return { tx, calls, counted: () => counted, summed: () => summed };
}

const inReseller = <R>(fn: () => Promise<R>) => runWithTenant({ id: RESELLER }, fn);

describe('assertPlatformGrantRoom (F-019-o)', () => {
  it('counts the reseller\'s open services on platform panels under its lock, and passes below the limit', async () => {
    const { tx, calls, counted } = fakeTx({ limits: { platform_open_grants_max: 3 }, count: 2 });
    await expect(inReseller(() => assertPlatformGrantRoom(tx as never, VARIANT))).resolves.toBeUndefined();
    expect(calls).toEqual(['lock', 'count']);
    expect(counted()).toEqual({
      tenantId: RESELLER,
      status: { in: [GrantStatus.pending, GrantStatus.active, GrantStatus.suspended] },
      variant: { panelGroup: { members: { some: { panel: { ownershipType: 'platform' } } } } },
    });
  });

  it('refuses one more at the limit, with the figures', async () => {
    const { tx } = fakeTx({ limits: { platform_open_grants_max: 3 }, count: 3 });
    const err = await inReseller(() => assertPlatformGrantRoom(tx as never, VARIANT)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResellerLimitReached);
    expect(err).toMatchObject({ key: 'platform_open_grants_max', limit: 3, used: 3 });
  });

  it('counts nothing for a variant on the reseller\'s own panels, with no limit, or on the platform\'s tenant', async () => {
    for (const opts of [{ platformPanel: false }, { limits: { platform_open_grants_max: null } }, { tenantType: 'platform_owner' }]) {
      const { tx, calls } = fakeTx({ ...opts, count: 10_000 });
      await expect(runWithTenant({ id: opts.tenantType ? PLATFORM : RESELLER }, () => assertPlatformGrantRoom(tx as never, VARIANT))).resolves.toBeUndefined();
      expect(calls).toEqual([]);
    }
  });
});

describe('the month\'s traffic on platform panels (F-019-t6)', () => {
  const GIB = BigInt(1024 ** 3);

  it('sums this calendar month\'s bytes of the reseller\'s configs on platform panels, in whole GiB, and refuses at the limit', async () => {
    const { tx, summed } = fakeTx({ limits: { platform_traffic_gib_monthly_max: 10 }, bytes: { up: BigInt(2) * GIB, down: BigInt(8) * GIB } });
    const err = await inReseller(() => assertPlatformTrafficRoom(tx as never, VARIANT, NOW)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResellerLimitReached);
    expect(err).toMatchObject({ key: 'platform_traffic_gib_monthly_max', limit: 10, used: 10 });
    expect(summed()).toEqual({ date: { gte: new Date('2026-10-01T00:00:00Z') }, config: { tenantId: RESELLER, panel: { ownershipType: 'platform' } } });
  });

  it('passes under the limit, and is also asked by a new service on platform panels', async () => {
    const under = fakeTx({ limits: { platform_traffic_gib_monthly_max: 10 }, bytes: { up: BigInt(0), down: BigInt(10) * GIB - BigInt(1) } });
    await expect(inReseller(() => assertPlatformTrafficRoom(under.tx as never, VARIANT, NOW))).resolves.toBeUndefined();
    const full = fakeTx({ limits: { platform_traffic_gib_monthly_max: 1 }, bytes: { up: GIB, down: BigInt(0) } });
    await expect(inReseller(() => assertPlatformGrantRoom(full.tx as never, VARIANT))).rejects.toMatchObject({ key: 'platform_traffic_gib_monthly_max' });
  });

  it('reads nothing with no limit (the default), or on the reseller\'s own panels', async () => {
    for (const opts of [{}, { platformPanel: false, limits: { platform_traffic_gib_monthly_max: 1 } }]) {
      const { tx, calls } = fakeTx(opts);
      await inReseller(() => assertPlatformTrafficRoom(tx as never, VARIANT, NOW));
      expect(calls).not.toContain('traffic');
    }
  });
});

describe('assertAdminIssueRoom (F-019-p)', () => {
  it('counts services issued by hand in the last 30 days under the reseller\'s lock', async () => {
    const { tx, calls, counted } = fakeTx({ limits: { admin_issues_30d_max: 2 }, count: 1 });
    await expect(inReseller(() => assertAdminIssueRoom(tx as never, NOW))).resolves.toBeUndefined();
    expect(calls).toEqual(['lock', 'count']);
    expect(counted()).toEqual({ tenantId: RESELLER, source: GrantSource.admin_grant, createdAt: { gt: new Date('2026-09-01T12:00:00Z') } });
  });

  it('refuses one more at the limit, using the default 50 when nothing is set', async () => {
    const { tx } = fakeTx({ count: 50 });
    await expect(inReseller(() => assertAdminIssueRoom(tx as never, NOW))).rejects.toMatchObject({ key: 'admin_issues_30d_max', limit: 50, used: 50 });
  });
});
