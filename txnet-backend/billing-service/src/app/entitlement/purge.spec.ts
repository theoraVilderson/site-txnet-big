/**
 * Purge and restore — the second and third stages of ADR-0075 (F-027-y).
 *
 * `suspendForExhaustion` (F-027-x) stops the service and starts a clock. These
 * are what the clock runs into, and what a top-up undoes. What would break
 * silently here, and nowhere else:
 *
 *  - **the clock is read live, and `0` means never.** `purgeAfterDays` resolves
 *    `coalesce(grant, tenant)`, so a tenant that shortens its window means it
 *    for the Grants already waiting. A row that resolves to `0` must never be
 *    scanned — not merely skipped after the fact, because the scan is a bounded
 *    batch ordered oldest-first and a never-purge row at the front of it would
 *    starve every due row behind it, for ever;
 *  - **the scan is cross-tenant and the writes are not**, for the reason
 *    `deposit-expiry.service.ts` gives: which tenants have a due Grant is the
 *    question, and on the application pool `entitlement."grant"`'s RLS shows a
 *    connection with no `app.tenant_id` zero rows;
 *  - **nothing is deleted.** The purge writes `desiredRemote = absent` and
 *    touches neither the `Config` row nor its `remoteId`. Clearing `remoteId`
 *    is the convergence loop's, once the panel confirms the delete (F-027-z);
 *  - **a revive is conditional on the reason, not just the status.**
 *    `suspended` has two meanings (ADR-0075), and a top-up must not lift an
 *    admin's suspension;
 *  - **a revive restores desired state from either stage** — re-enabled if
 *    merely suspended, `present` again if purged — because that is what makes
 *    a rebuild a button rather than an operation.
 *
 * What the database holds rather than this file: `grant_suspended_has_a_clock`
 * and `grant_status_one_way` are `entitlement-schema.int.spec.ts`'s.
 */
import { ConfigStatus, DesiredRemote, EnforcementState, GrantStatus } from '@prisma/client';
import { TenantContext } from '@txnet-backend/shared-core';

import { GrantPurgeService, reviveOnTopUp } from './purge';
import { QUOTA_EXHAUSTED } from './suspension';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const GRANT_1 = '99999999-9999-4999-8999-999999999991';
const GRANT_2 = '99999999-9999-4999-8999-999999999992';
const GRANT_3 = '99999999-9999-4999-8999-999999999993';

type Due = { id: string; tenantId: string };

type Calls = {
  scans: Array<{ now: Date; take: number; tenantInScope: string | null }>;
  updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown>; tenantInScope: string | null }>;
};

function build(setup: { due?: Due[]; batchSize?: number; configsPerTenant?: number } = {}) {
  const { due = [], batchSize = 200, configsPerTenant = 1 } = setup;
  const calls: Calls = { scans: [], updated: [] };

  const scoped = () => TenantContext.currentOrNull()?.id ?? null;

  const tx = {
    // `tenantTransaction` binds `app.tenant_id` beside the write (F-094).
    $executeRaw: async () => 0,
    config: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        calls.updated.push({ where, data, tenantInScope: scoped() });
        return { count: configsPerTenant };
      },
    },
  };

  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };

  const crossTenant = {
    // The due scan is one join across `entitlement."grant"` and `tenant.tenant`,
    // so it arrives here as a tagged template rather than a `findMany`.
    $queryRaw: async (
      _sql: TemplateStringsArray,
      _status: string,
      _frozen: string,
      now: Date,
      _present: string,
      take: number,
    ) => {
      calls.scans.push({ now, take, tenantInScope: scoped() });
      return due;
    },
  };

  const config = { get: () => batchSize };

  return { service: new GrantPurgeService(prisma as never, crossTenant as never, config as never), calls };
}

describe('GrantPurgeService.purgeDue', () => {
  it('asks the panel to drop a due Grant without deleting anything of ours', async () => {
    const { service, calls } = build({ due: [{ id: GRANT_1, tenantId: TENANT_A }] });

    const result = await service.purgeDue(new Date('2026-09-23T10:00:00Z'));

    expect(result).toEqual({ scanned: 1, grantsPurged: 1, configsPurged: 1 });
    expect(calls.updated).toHaveLength(1);
    const [write] = calls.updated;
    expect(write.data).toEqual({ desiredRemote: DesiredRemote.absent, enforcementState: EnforcementState.pending });
    // The row and its `remoteId` are the convergence loop's to touch, not ours.
    expect(write.data).not.toHaveProperty('remoteId');
    expect(write.where).toMatchObject({ grantId: { in: [GRANT_1] }, desiredRemote: DesiredRemote.present });
  });

  it('scans across tenants and writes inside one', async () => {
    const { service, calls } = build({
      due: [
        { id: GRANT_1, tenantId: TENANT_A },
        { id: GRANT_2, tenantId: TENANT_B },
        { id: GRANT_3, tenantId: TENANT_A },
      ],
    });

    const result = await service.purgeDue();

    expect(calls.scans[0].tenantInScope).toBeNull();
    expect(result.grantsPurged).toBe(3);
    // One write per tenant, each in that tenant's scope — never one sweep in one scope.
    expect(calls.updated.map((u) => u.tenantInScope).sort()).toEqual([TENANT_A, TENANT_B]);
    const forA = calls.updated.find((u) => u.tenantInScope === TENANT_A);
    expect(forA?.where).toMatchObject({ grantId: { in: [GRANT_1, GRANT_3] } });
  });

  it('carries one `now` and the configured batch into the scan', async () => {
    const now = new Date('2026-09-23T10:00:00Z');
    const { service, calls } = build({ batchSize: 50 });

    const result = await service.purgeDue(now);

    expect(calls.scans).toEqual([{ now, take: 50, tenantInScope: null }]);
    expect(result).toEqual({ scanned: 0, grantsPurged: 0, configsPurged: 0 });
    // Nothing due is no write at all, not an empty one.
    expect(calls.updated).toHaveLength(0);
  });
});

describe('reviveOnTopUp', () => {
  type Row = { status: GrantStatus; statusReason: string | null };

  function grantTx(row: Row | null, configs = 2) {
    const writes: Array<{ table: string; where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const tx = {
      grant: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          writes.push({ table: 'grant', where, data });
          const matches =
            row !== null && row.status === where['status'] && row.statusReason === where['statusReason'];
          return { count: matches ? 1 : 0 };
        },
      },
      config: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          writes.push({ table: 'config', where, data });
          return { count: configs };
        },
      },
    };
    return { tx, writes };
  }

  it('returns a suspended Grant to active and its configs to present and enabled', async () => {
    const { tx, writes } = grantTx({ status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED });

    const result = await reviveOnTopUp(tx as never, GRANT_1);

    expect(result).toEqual({ revived: true, configsRestored: 2 });
    const grantWrite = writes.find((w) => w.table === 'grant');
    expect(grantWrite?.data).toEqual({
      status: GrantStatus.active,
      statusReason: null,
      suspendedAt: null,
    });
    const configWrite = writes.find((w) => w.table === 'config');
    // From *either* stage: merely disabled, or already purged.
    expect(configWrite?.data).toEqual({
      desiredEnabled: true,
      desiredRemote: DesiredRemote.present,
      enforcementState: EnforcementState.pending,
    });
    // Never a retired config — deleted or moved away — and never one an admin disabled (F-027-z).
    expect(configWrite?.where).toEqual({ grantId: GRANT_1, status: ConfigStatus.active });
  });

  it('will not lift a suspension it did not impose', async () => {
    const { tx, writes } = grantTx({ status: GrantStatus.suspended, statusReason: 'tenant_suspended' });

    const result = await reviveOnTopUp(tx as never, GRANT_1);

    expect(result).toEqual({ revived: false, configsRestored: 0 });
    // The guard is in the write's own `where`, so nothing is read-then-written.
    expect(writes.find((w) => w.table === 'grant')?.where).toMatchObject({
      id: GRANT_1,
      status: GrantStatus.suspended,
      statusReason: QUOTA_EXHAUSTED,
    });
    expect(writes.some((w) => w.table === 'config')).toBe(false);
  });

  it('is a no-op on a Grant that moved on, so a repeat costs nothing', async () => {
    const { tx, writes } = grantTx({ status: GrantStatus.cancelled, statusReason: null });

    expect(await reviveOnTopUp(tx as never, GRANT_1)).toEqual({ revived: false, configsRestored: 0 });
    expect(writes.some((w) => w.table === 'config')).toBe(false);
  });
});
