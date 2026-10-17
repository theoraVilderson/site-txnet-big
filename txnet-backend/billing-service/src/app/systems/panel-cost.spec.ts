/**
 * A panel's monthly cost (F-1002-a, network `contract.md` "A panel's cost").
 *
 * The ways this goes wrong quietly:
 *
 *  - **a past month's margin moves.** A price is history: a change adds a row
 *    and never edits one, and it cannot take effect inside a month that has
 *    already closed — so what a closed month cost is fixed once it closes;
 *  - **the wrong price on a day.** The price on a day is the row with the
 *    latest `effectiveFrom` on or before it; two rows from the same day are
 *    settled by the later one written;
 *  - **another tenant's panel priced.** The panel must be in the actor's
 *    scope (ADR-0080 decision 2), or it does not exist.
 */
import { Prisma } from '@prisma/client';

import { PanelCostService, panelCostSchema } from './panel-cost';

const PLATFORM_TENANT = '10000000-0000-4000-8000-000000000001';
import { costOn } from './panel-cost-on';
import { PanelScopeRefused } from './panel-scope';
import { SystemsRefused } from './systems-read';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const PANEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-16T09:00:00Z');

const row = (effectiveFrom: string, amount: string, createdAt = '2026-10-01T00:00:00Z') => ({
  id: `${effectiveFrom}-${amount}`,
  panelId: PANEL,
  monthlyCostUsd: new Prisma.Decimal(amount),
  effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
  createdByUserId: ADMIN,
  createdAt: new Date(createdAt),
});

function build(history = [row('2026-09-01', '40.00')]) {
  const created: unknown[] = [];
  const prisma = {
    tenant: { findUnique: async ({ where }: { where: { id: string } }) => ({ tenantType: where.id === PLATFORM ? 'platform_owner' : 'reseller' }) },
    panel: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === PANEL ? { id: PANEL, retiredAt: null } : null) },
    panelCost: { findMany: async () => [...history].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || b.createdAt.getTime() - a.createdAt.getTime()) },
  };
  const restated: unknown[][] = [];
  const all = {
    panelCost: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        history.push({ ...row(String(data.effectiveFrom instanceof Date ? data.effectiveFrom.toISOString().slice(0, 10) : ''), String(data.monthlyCostUsd)), createdAt: NOW });
        return data;
      },
      update: async () => {
        throw new Error('a price is never edited');
      },
    },
    tenant: { findFirst: async () => ({ id: PLATFORM_TENANT }) },
    // F-1002-e: the write asks the platform's cost rows restated from its day.
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => (restated.push(values), 1),
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(all),
  };
  return { created, restated, service: new PanelCostService(prisma as never, all as never) };
}

const platform = { adminId: ADMIN, tenantId: PLATFORM };

describe('the cost body', () => {
  it('takes USD as a decimal string of at most two places, and a real day', () => {
    expect(panelCostSchema.safeParse({ monthlyCostUsd: '12.50' }).success).toBe(true);
    expect(panelCostSchema.safeParse({ monthlyCostUsd: '0', effectiveFrom: '2026-11-01' }).success).toBe(true);
    for (const monthlyCostUsd of ['12.505', '-1', '1e3', 12.5]) expect(panelCostSchema.safeParse({ monthlyCostUsd }).success).toBe(false);
    expect(panelCostSchema.safeParse({ monthlyCostUsd: '1', effectiveFrom: '2026-02-30' }).success).toBe(false);
  });
});

describe('costOn', () => {
  const history = [row('2026-09-01', '40.00'), row('2026-10-10', '55.00'), row('2026-10-10', '50.00', '2026-10-11T00:00:00Z')];

  it('is the latest price that took effect on or before the day — the later written of one day', () => {
    expect(costOn(history, '2026-09-30')?.monthlyCostUsd.toFixed(2)).toBe('40.00');
    expect(costOn(history, '2026-10-10')?.monthlyCostUsd.toFixed(2)).toBe('50.00');
  });

  it('is none before the first price', () => {
    expect(costOn(history, '2026-08-31')).toBeNull();
  });
});

describe('PanelCostService', () => {
  it('adds a row for a change, from today unless told otherwise, and answers the history', async () => {
    const { created, restated, service } = build();
    const answer = await service.set(platform, PANEL, { monthlyCostUsd: '60.00' }, NOW);
    // The platform's cost rows from the day before it took effect are restated on the next pass.
    expect(restated).toEqual([expect.arrayContaining(['2026-10-15', PLATFORM_TENANT])]);
    expect(created).toEqual([{ panelId: PANEL, monthlyCostUsd: '60.00', monthlyTrafficBytes: null, effectiveFrom: new Date('2026-10-16T00:00:00Z'), createdByUserId: ADMIN }]);
    expect(answer.current).toMatchObject({ monthlyCostUsd: '60.00', effectiveFrom: '2026-10-16' });
    expect(answer.history.map((h) => h.monthlyCostUsd)).toEqual(['60.00', '40.00']);
  });

  it('refuses a price taking effect in a month that has closed — a past margin never moves', async () => {
    const { created, service } = build();
    await expect(service.set(platform, PANEL, { monthlyCostUsd: '1', effectiveFrom: '2026-09-30' }, NOW)).rejects.toMatchObject({ reason: 'cost_in_closed_month' });
    await expect(service.set(platform, PANEL, { monthlyCostUsd: '1', effectiveFrom: '2026-10-01' }, NOW)).resolves.toBeDefined();
    expect(created).toHaveLength(1);
  });

  it('knows no panel outside the scope, and no scope outside the platform', async () => {
    const { service } = build();
    await expect(service.set(platform, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', { monthlyCostUsd: '1' }, NOW)).rejects.toBeInstanceOf(SystemsRefused);
    await expect(service.history({ adminId: ADMIN, tenantId: RESELLER }, PANEL)).rejects.toBeInstanceOf(PanelScopeRefused);
  });
});
