/**
 * The close stage — the third stage after ADR-0075's suspension and purge
 * (F-118-x, D-59 (b)). What would break silently here, and nowhere else:
 *
 *  - **the Grant closes before the money moves.** The remainder credit refuses
 *    a Grant that is not closed (`grant_not_closed`), so `expired` is written
 *    first, in the same transaction as the credit, the other meters' settle and
 *    the wholesale give-back;
 *  - **the close is guarded on what the scan read** — status, reason and
 *    `suspendedAt` — so a Grant a renewal or a top-up revived between the scan
 *    and the write is left alone, with nothing credited;
 *  - **a remainder that finds nothing still closes**, but a block bought
 *    meanwhile (`cursor_moved`) rolls that Grant back for the next tick, and the
 *    rest of the batch goes on;
 *  - **the window follows the purge, and either `0` means never**, resolved in
 *    the scan for the reason `purge.ts` gives; a frozen Grant is never scanned.
 */
import { DesiredRemote, EnforcementState, GrantStatus } from '@prisma/client';
import { TenantContext } from '@txnet-backend/shared-core';

import { RemainderCreditRefused } from '../traffic/remainder-credit';
import { CLOSED_AFTER_PURGE, GrantCloseStageService } from './close-stage';
import { ADMIN_FROZEN, QUOTA_EXHAUSTED } from './suspension';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const GRANT_1 = '99999999-9999-4999-8999-999999999991';
const GRANT_2 = '99999999-9999-4999-8999-999999999992';
const SUSPENDED_AT = new Date('2026-08-01T10:00:00Z');
const NOW = new Date('2026-09-30T10:00:00Z');

type Due = { id: string; tenantId: string; statusReason: string | null; suspendedAt: Date };

function build(setup: { due?: Due[]; moved?: boolean; refuse?: Record<string, RemainderCreditRefused['reason']> } = {}) {
  const { due = [], moved = true, refuse = {} } = setup;
  const log: string[] = [];
  const grantWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown>; tenant: string | null }> = [];
  const configWrites: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const scans: Array<{ sql: string; values: unknown[]; tenant: string | null }> = [];
  const scoped = () => TenantContext.currentOrNull()?.id ?? null;

  const tx = {
    $executeRaw: async () => 0,
    grant: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        grantWrites.push({ where, data, tenant: scoped() });
        log.push(`close ${where.id}`);
        return { count: moved ? 1 : 0 };
      },
    },
    config: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        configWrites.push({ where, data });
        return { count: 2 };
      },
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const crossTenant = {
    $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
      scans.push({ sql: sql.join('?'), values, tenant: scoped() });
      return due;
    },
  };
  const config = { get: () => 200 };
  const remainders = {
    settle: async (_tx: unknown, input: { grantId: string; stoppedAt: Date | null }) => {
      log.push(`remainder ${input.grantId} stoppedAt=${input.stoppedAt}`);
      const reason = refuse[input.grantId];
      if (reason) throw new RemainderCreditRefused(reason);
      return { amount: 1, walletTransactionId: 'w' };
    },
    wholesaleAtClose: async (_tx: unknown, grantId: string) => void log.push(`wholesale ${grantId}`),
  };
  const meters = {
    settleAtClose: async (_tx: unknown, input: { grantId: string; refund?: boolean }) => void log.push(`meters ${input.grantId} refund=${input.refund}`),
  };

  const service = new GrantCloseStageService(prisma as never, crossTenant as never, config as never, remainders as never, meters as never);
  return { service, log, grantWrites, configWrites, scans };
}

const due = (id: string, tenantId = TENANT_A): Due => ({ id, tenantId, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT });

describe('GrantCloseStageService.closeDue', () => {
  it('expires a due Grant, then gives back the VPN remainder, every other meter and the wholesale leg', async () => {
    const { service, log, grantWrites, configWrites } = build({ due: [due(GRANT_1)] });

    await expect(service.closeDue(NOW)).resolves.toEqual({ scanned: 1, closed: 1, failed: 0 });

    expect(grantWrites[0].where).toEqual({ id: GRANT_1, status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED, suspendedAt: SUSPENDED_AT });
    expect(grantWrites[0].data).toEqual({ status: GrantStatus.expired, statusReason: CLOSED_AFTER_PURGE });
    expect(configWrites[0]).toEqual({
      where: { grantId: GRANT_1, desiredRemote: DesiredRemote.present },
      data: { desiredRemote: DesiredRemote.absent, desiredEnabled: false, enforcementState: EnforcementState.pending },
    });
    // Closed first: the credit refuses a Grant that still reads `suspended`.
    expect(log).toEqual([`close ${GRANT_1}`, `remainder ${GRANT_1} stoppedAt=null`, `meters ${GRANT_1} refund=true`, `wholesale ${GRANT_1}`]);
  });

  it('leaves a Grant revived since the scan alone, with nothing credited', async () => {
    const { service, log } = build({ due: [due(GRANT_1)], moved: false });

    await expect(service.closeDue(NOW)).resolves.toEqual({ scanned: 1, closed: 0, failed: 0 });
    expect(log).toEqual([`close ${GRANT_1}`]);
  });

  it('still closes when the remainder finds nothing, and gives the wholesale back', async () => {
    const { service, log } = build({ due: [due(GRANT_1)], refuse: { [GRANT_1]: 'nothing_to_credit' } });

    await expect(service.closeDue(NOW)).resolves.toEqual({ scanned: 1, closed: 1, failed: 0 });
    expect(log).toContain(`wholesale ${GRANT_1}`);
  });

  it('rolls back a Grant whose cursor moved and closes the rest of the batch', async () => {
    const { service, log } = build({ due: [due(GRANT_1), due(GRANT_2, TENANT_B)], refuse: { [GRANT_1]: 'cursor_moved' } });

    await expect(service.closeDue(NOW)).resolves.toEqual({ scanned: 2, closed: 1, failed: 1 });
    expect(log).not.toContain(`wholesale ${GRANT_1}`);
    expect(log).toContain(`wholesale ${GRANT_2}`);
  });

  it('scans across tenants, writes inside each, and never scans a frozen or never-closing Grant', async () => {
    const { service, grantWrites, scans } = build({ due: [due(GRANT_1), due(GRANT_2, TENANT_B)] });

    await service.closeDue(NOW);

    expect(scans[0].tenant).toBeNull();
    expect(grantWrites.map((w) => w.tenant)).toEqual([TENANT_A, TENANT_B]);
    expect(scans[0].values).toContain(ADMIN_FROZEN);
    expect(scans[0].values).toContain(NOW);
    const sql = scans[0].sql.replace(/\s+/g, ' ');
    expect(sql).toContain('COALESCE(g."purgeAfterDays", t."purgeAfterDays") > 0');
    expect(sql).toContain('COALESCE(g."closeAfterDays", t."closeAfterDays") > 0');
    expect(sql).toContain('make_interval(days => COALESCE(g."purgeAfterDays", t."purgeAfterDays") + COALESCE(g."closeAfterDays", t."closeAfterDays"))');
  });

  it('answers zero without a transaction when nothing is due', async () => {
    const { service, grantWrites } = build();
    await expect(service.closeDue(NOW)).resolves.toEqual({ scanned: 0, closed: 0, failed: 0 });
    expect(grantWrites).toHaveLength(0);
  });
});
