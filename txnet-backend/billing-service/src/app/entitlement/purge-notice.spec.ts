/**
 * Before purge — F-601-j (spec 9.5, beyond the catalog). A suspended Grant is
 * told once, a day before `purgeAfterDays` drops its configs from the panel
 * (F-027-y), what keeps them: a renewal, or a top-up for a metered Grant.
 *
 * What would break silently here, and nowhere else:
 *
 *  - **once per suspension**: the clock is `purgeNoticeFor`, the `suspendedAt`
 *    it was told for, and the write is conditional on the value read — two
 *    sweeps emit once, and a Grant revived and suspended again is armed again
 *    with nothing resetting it;
 *  - **the window is the purge's own**: `coalesce(grant, tenant)` read live,
 *    `0` never scanned (purge off is never told), and a Grant already purged
 *    is not due — the scan asks the same `EXISTS` the purge asks;
 *  - **the words match what brings it back**: a metered Grant is revived by a
 *    top-up, never by a renewal (F-601-b's reason, again).
 */
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { OutboxEventType, TenantContext } from '@txnet-backend/shared-core';

import { GrantPurgeNoticeService, PurgeNoticeDue, purgeNoticeType } from './purge-notice';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const GRANT_1 = '99999999-9999-4999-8999-999999999991';
const GRANT_2 = '99999999-9999-4999-8999-999999999992';

const SUSPENDED = new Date('2026-09-20T10:00:00.000Z');
const NOW = new Date('2026-09-26T11:00:00.000Z');

function due(over: Partial<PurgeNoticeDue> = {}): PurgeNoticeDue {
  return {
    id: GRANT_1,
    tenantId: TENANT_A,
    userId: USER,
    billingMode: VariantBillingMode.prepaid,
    suspendedAt: SUSPENDED,
    purgeNoticeFor: null,
    ...over,
  };
}

function build(rows: PurgeNoticeDue[] = [], opts: { raced?: boolean; batchSize?: number } = {}) {
  const seen = {
    scans: [] as Array<{ values: unknown[]; tenantInScope: string | null }>,
    writes: [] as Array<{ where: Record<string, unknown>; data: Record<string, unknown>; tenantInScope: string | null }>,
    outbox: [] as Array<{ type: string; aggregateId: string; payload: Record<string, unknown> }>,
  };
  const scoped = () => TenantContext.currentOrNull()?.id ?? null;
  const tx = {
    $executeRaw: async () => 0,
    grant: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        seen.writes.push({ where, data, tenantInScope: scoped() });
        return { count: opts.raced ? 0 : 1 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; aggregateId: string; payload: Record<string, unknown> } }) => {
        seen.outbox.push({ type: data.type, aggregateId: data.aggregateId, payload: data.payload });
        return { id: 'e1' };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const crossTenant = {
    $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      seen.scans.push({ values: [sql.join('?'), ...values], tenantInScope: scoped() });
      return rows;
    },
  };
  const config = { get: () => opts.batchSize ?? 200 };
  const service = new GrantPurgeNoticeService(prisma as never, crossTenant as never, config as never);
  return { service, tx: tx as never as Prisma.TransactionClient, seen };
}

describe('purgeNoticeType (F-601-j)', () => {
  it('tells a prepaid Grant to renew and a metered one to top up', () => {
    expect(purgeNoticeType(VariantBillingMode.prepaid)).toBe(OutboxEventType.GRANT_PURGE_SOON);
    expect(purgeNoticeType(VariantBillingMode.metered)).toBe(OutboxEventType.GRANT_PURGE_SOON_METERED);
  });
});

describe('GrantPurgeNoticeService.noticeDue (F-601-j)', () => {
  it('emits one notice for the suspension, period = suspendedAt, and sets the clock to it', async () => {
    const { service, seen } = build([due()]);

    expect(await service.noticeDue(NOW)).toEqual({ scanned: 1, told: 1 });

    expect(seen.writes).toHaveLength(1);
    expect(seen.writes[0].where).toEqual({
      id: GRANT_1,
      status: GrantStatus.suspended,
      suspendedAt: SUSPENDED,
      purgeNoticeFor: null,
    });
    expect(seen.writes[0].data).toEqual({ purgeNoticeFor: SUSPENDED });
    expect(seen.outbox).toEqual([
      {
        type: OutboxEventType.GRANT_PURGE_SOON,
        aggregateId: GRANT_1,
        payload: { tenantId: TENANT_A, userId: USER, grantId: GRANT_1, period: SUSPENDED.toISOString() },
      },
    ]);
  });

  it('a metered Grant is told to top up', async () => {
    const { service, seen } = build([due({ billingMode: VariantBillingMode.metered })]);
    await service.noticeDue(NOW);
    expect(seen.outbox.map((e) => e.type)).toEqual([OutboxEventType.GRANT_PURGE_SOON_METERED]);
  });

  it('a clock left by an earlier suspension is the value the write is conditional on', async () => {
    const earlier = new Date('2026-08-01T00:00:00.000Z');
    const { service, seen } = build([due({ purgeNoticeFor: earlier })]);
    await service.noticeDue(NOW);
    expect(seen.writes[0].where).toMatchObject({ purgeNoticeFor: earlier });
    expect(seen.outbox).toHaveLength(1);
  });

  it('a racing sweep that moved the clock first emits nothing', async () => {
    const { service, seen } = build([due()], { raced: true });
    expect(await service.noticeDue(NOW)).toEqual({ scanned: 1, told: 0 });
    expect(seen.outbox).toHaveLength(0);
  });

  it('scans across tenants and writes inside each', async () => {
    const { service, seen } = build([due(), due({ id: GRANT_2, tenantId: TENANT_B })]);
    await service.noticeDue(NOW);
    expect(seen.scans[0].tenantInScope).toBeNull();
    expect(seen.writes.map((w) => w.tenantInScope)).toEqual([TENANT_A, TENANT_B]);
  });

  it('the scan is the purge window less a day, never a window of 0, never a Grant told or purged', async () => {
    const { service, seen } = build([], { batchSize: 50 });

    expect(await service.noticeDue(NOW)).toEqual({ scanned: 0, told: 0 });

    const [sql, ...values] = seen.scans[0].values as [string, ...unknown[]];
    expect(sql).toMatch(/COALESCE\(g\."purgeAfterDays", t\."purgeAfterDays"\) > 0/);
    expect(sql).toMatch(/make_interval\(days => COALESCE\(g\."purgeAfterDays", t\."purgeAfterDays"\) - 1\)/);
    expect(sql).toMatch(/"purgeNoticeFor" IS DISTINCT FROM g\."suspendedAt"/);
    expect(sql).toMatch(/"desiredRemote" = \?::"network"\."DesiredRemote"/);
    expect(values).toContain(NOW);
    expect(values).toContain(50);
    expect(seen.writes).toHaveLength(0);
  });
});
