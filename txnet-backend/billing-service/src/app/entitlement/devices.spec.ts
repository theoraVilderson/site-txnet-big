/**
 * An admin sets a Grant's device limit (F-311-q, spec F-311). What would break
 * quietly here, and nowhere else:
 *
 *  - **the limit is the Grant's own quota**, `quotas.concurrent_devices.limit`
 *    — the figure a variant sold is copied into, and the one network's
 *    convergence reads — never a second copy elsewhere; the other metrics in
 *    `quotas` are left exactly as they were;
 *  - **one `quota_adjustment` row per change** (invariant 3): metric
 *    `concurrent_devices`, source `admin_grant`, the admin and the reason;
 *  - **written where it is enforced, and the rest named** (user, 2026-09-28):
 *    a panel that does not answer `per_client_ip_limit` yes does not refuse the
 *    change — the answer names it, so the admin knows where it is not held;
 *  - **conditional on the quotas it read**: a concurrent change is `grant_moved`;
 *  - `null` lifts it; the limit it already has is `devices_unchanged`; a closed
 *    Grant is `grant_closed`, a pending one `grant_not_active`.
 */
import { DesiredRemote, GrantSource, GrantStatus, QuotaMetric } from '@prisma/client';

import { setGrantDeviceLimit } from './devices';
import { EntitlementRefused } from './grant';

const GRANT = '99999999-9999-4999-8999-999999999991';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const AT = new Date('2026-09-28T10:00:00.000Z');

type Panel = { id: string; name: string; transport: string; capabilities: unknown };

const answered = (ip: boolean) => ({ version: 1, answers: { per_client_ip_limit: { supported: ip } } });
const XUI: Panel = { id: 'p-xui', name: 'Frankfurt 3x-ui', transport: 'pull', capabilities: answered(true) };
const MARZBAN: Panel = { id: 'p-marz', name: 'Tehran Marzban', transport: 'pull', capabilities: answered(false) };
const UNTESTED: Panel = { id: 'p-new', name: 'Untested', transport: 'pull', capabilities: null };

const TRAFFIC = { traffic_bytes: { limit: 1073741824, resetPolicy: 'none' } };

function build(status: GrantStatus, quotas: Record<string, unknown>, panels: Panel[] = [XUI], moved = false) {
  let stored: unknown = quotas;
  const adjustments: Record<string, unknown>[] = [];
  const updateWhere: unknown[] = [];
  const tx = {
    grant: {
      findUnique: vi.fn(async () => ({ id: GRANT, tenantId: TENANT, status, quotas: stored })),
      updateMany: vi.fn(async ({ where, data }: { where: unknown; data: { quotas: unknown } }) => {
        updateWhere.push(where);
        if (moved) return { count: 0 };
        stored = data.quotas;
        return { count: 1 };
      }),
    },
    quotaAdjustment: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        adjustments.push(data);
        return { id: 'adj-1' };
      }),
    },
    config: { findMany: vi.fn(async () => panels.map((panel) => ({ panel }))) },
  };
  return { tx: tx as never, stored: () => stored, adjustments, updateWhere };
}

const input = (limit: number | null) => ({ limit, reason: 'shared link', actorUserId: ADMIN, at: AT });

describe('setGrantDeviceLimit (F-311-q)', () => {
  it('writes the limit into the Grant’s own quotas, conditionally, and leaves the other metrics alone', async () => {
    const { tx, stored, updateWhere } = build(GrantStatus.active, TRAFFIC);
    const done = await setGrantDeviceLimit(tx, GRANT, input(2));
    expect(done).toEqual({ grantId: GRANT, adjustmentId: 'adj-1', limitBefore: null, limitAfter: 2, panelsNotEnforcing: [] });
    expect(stored()).toEqual({ ...TRAFFIC, concurrent_devices: { limit: 2 } });
    expect(updateWhere[0]).toEqual({ id: GRANT, quotas: { equals: TRAFFIC } });
  });

  it('writes one concurrent_devices adjustment row: the admin, the reason, the change', async () => {
    const { tx, adjustments } = build(GrantStatus.suspended, { ...TRAFFIC, concurrent_devices: { limit: 5, resetPolicy: 'none' } });
    await setGrantDeviceLimit(tx, GRANT, input(2));
    expect(adjustments).toEqual([
      {
        tenantId: TENANT,
        grantId: GRANT,
        metric: QuotaMetric.concurrent_devices,
        delta: BigInt(-3),
        source: GrantSource.admin_grant,
        reason: 'shared link',
        createdByAdminId: ADMIN,
      },
    ]);
  });

  it('keeps the sold entry’s other fields when it changes the limit', async () => {
    const { tx, stored } = build(GrantStatus.active, { concurrent_devices: { limit: 5, resetPolicy: 'none' } });
    await setGrantDeviceLimit(tx, GRANT, input(3));
    expect(stored()).toEqual({ concurrent_devices: { limit: 3, resetPolicy: 'none' } });
  });

  it('names the panels that will not hold it, and writes it anyway', async () => {
    const { tx, stored } = build(GrantStatus.active, TRAFFIC, [XUI, MARZBAN, UNTESTED, MARZBAN]);
    const done = await setGrantDeviceLimit(tx, GRANT, input(2));
    expect(done.panelsNotEnforcing).toEqual([
      { id: 'p-marz', name: 'Tehran Marzban' },
      { id: 'p-new', name: 'Untested' },
    ]);
    expect(stored()).toMatchObject({ concurrent_devices: { limit: 2 } });
  });

  it('lifts it with null: the entry goes, and no panel is named', async () => {
    const { tx, stored, adjustments } = build(GrantStatus.active, { ...TRAFFIC, concurrent_devices: { limit: 2 } }, [MARZBAN]);
    const done = await setGrantDeviceLimit(tx, GRANT, input(null));
    expect(done).toMatchObject({ limitBefore: 2, limitAfter: null, panelsNotEnforcing: [] });
    expect(stored()).toEqual(TRAFFIC);
    expect(adjustments[0]).toMatchObject({ delta: BigInt(-2) });
  });

  it('refuses the limit it already has, and a lift of none', async () => {
    await expect(setGrantDeviceLimit(build(GrantStatus.active, { concurrent_devices: { limit: 2 } }).tx, GRANT, input(2))).rejects.toMatchObject({
      reason: 'devices_unchanged',
    });
    await expect(setGrantDeviceLimit(build(GrantStatus.active, TRAFFIC).tx, GRANT, input(null))).rejects.toMatchObject({ reason: 'devices_unchanged' });
  });

  it('refuses when the quotas moved since the read, and writes no row', async () => {
    const { tx, adjustments } = build(GrantStatus.active, TRAFFIC, [XUI], true);
    await expect(setGrantDeviceLimit(tx, GRANT, input(2))).rejects.toMatchObject({ reason: 'grant_moved' });
    expect(adjustments).toEqual([]);
  });

  it.each([
    [GrantStatus.expired, 'grant_closed'],
    [GrantStatus.exhausted, 'grant_closed'],
    [GrantStatus.cancelled, 'grant_closed'],
    [GrantStatus.pending, 'grant_not_active'],
  ])('refuses a %s Grant as %s', async (status, reason) => {
    const refusal = await setGrantDeviceLimit(build(status, TRAFFIC).tx, GRANT, input(2)).catch((e) => e);
    expect(refusal).toBeInstanceOf(EntitlementRefused);
    expect(refusal.reason).toBe(reason);
  });

  it('reads only live configs for the panels it names', async () => {
    const { tx } = build(GrantStatus.active, TRAFFIC);
    await setGrantDeviceLimit(tx, GRANT, input(2));
    expect((tx as unknown as { config: { findMany: ReturnType<typeof vi.fn> } }).config.findMany.mock.calls[0][0]).toMatchObject({
      where: { grantId: GRANT, desiredRemote: DesiredRemote.present },
    });
  });
});
