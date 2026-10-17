/**
 * A product's cost (F-1002-d, ADR-0151) — the service around the catalog's door.
 *
 * The ways this goes wrong quietly:
 *
 *  - **a cost in the wrong currency.** It is written in its tenant's pricing
 *    currency, as a price is, so the rollup converts it from the right one;
 *  - **another tenant's variant costed.** The catalog's door answers not
 *    found, and nothing is written;
 *  - **`vpn.traffic` offered a unit cost.** Its cost is its panels'; the list
 *    leaves it out (the schema and a CHECK refuse a write);
 *  - **the edge letting a closed month through.** A cost from before this UTC
 *    month would move a margin already reported.
 */
import { Prisma } from '@prisma/client';
import { METER_KEYS } from '@txnet-backend/shared-core';

import { CatalogActor, CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';
import { setMeterCostSchema, setVariantCostSchema, unsetMeterCostSchema, unsetVariantCostSchema } from './catalog-cost.schema';
import { CatalogCostService } from './catalog-cost.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const VARIANT = '44444444-4444-4444-8444-4444444444c1';
const actor: CatalogActor = { adminId: '33333333-3333-4333-8333-333333333333', tenantId: TENANT, ip: '127.0.0.1', permissions: ['catalog.manage'] };
const AT = new Date('2026-10-17T10:00:00Z');

function harness(variantTenant: string) {
  const written: Record<string, unknown>[] = [];
  const audits: string[] = [];
  const restated: unknown[][] = [];
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => (restated.push(values), 1),
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'IRT' }) },
    variantCost: { create: async ({ data }: { data: Record<string, unknown> }) => (written.push(data), { id: 'c1', createdAt: AT, ...data }) },
    meter: {
      findUnique: async ({ where }: { where: { key: string } }) => (where.key === 'api.calls' ? { key: 'api.calls' } : null),
      findMany: async ({ where }: { where: { key: { not: string } } }) =>
        [{ key: 'api.calls', unit: 'count', nameKey: 'n' }, { key: METER_KEYS.vpnTraffic, unit: 'bytes', nameKey: 'v' }].filter((m) => m.key !== where.key.not),
    },
    meterCost: {
      findMany: async () => [{ id: 'm1', meterKey: 'api.calls', unitSize: BigInt(1000), unitCost: new Prisma.Decimal('0.05'), currencyCode: 'IRT', effectiveFrom: AT, createdAt: AT }],
      create: async ({ data }: { data: Record<string, unknown> }) => (written.push(data), { id: 'm2', createdAt: AT, ...data }),
    },
  };
  const door = {
    access: async () => ({ owner: false }),
    ownerOfNew: async (a: CatalogActor, requested?: string) => requested ?? a.tenantId,
    within: (_owner: boolean, fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
    managed: async (_db: unknown, _model: string, missing: 'variant_not_found', a: CatalogActor, id: string) => {
      if (variantTenant !== a.tenantId) throw new CatalogAdminRefused(missing, id);
      return { id, tenantId: variantTenant };
    },
    audit: async (_tx: unknown, _a: unknown, _t: unknown, action: string) => void audits.push(action),
  } as unknown as CatalogAdminService;
  return { costs: new CatalogCostService(door), written, audits, restated };
}

describe('CatalogCostService', () => {
  it("writes a variant's cost per sale in its tenant's pricing currency, audited", async () => {
    const h = harness(TENANT);
    const view = await h.costs.setVariantCost(actor, VARIANT, { amount: '2.50' });
    expect(view).toMatchObject({ amount: '2.50', currencyCode: 'IRT' });
    expect(h.written[0]).toMatchObject({ tenantId: TENANT, variantId: VARIANT, currencyCode: 'IRT', createdByAdminId: actor.adminId });
    expect(h.audits).toEqual(['catalog_variant_cost_set']);
    // Its days already rolled are restated from the day before it took effect (F-1002-e).
    expect(h.restated).toHaveLength(1);
    expect(h.restated[0]).toContain(TENANT);
  });

  it("refuses another tenant's variant as not found, and writes nothing", async () => {
    const h = harness(OTHER);
    await expect(h.costs.setVariantCost(actor, VARIANT, { amount: '1.00' })).rejects.toMatchObject({ reason: 'variant_not_found' });
    expect(h.written).toEqual([]);
  });

  it('lists every meter but vpn.traffic with its cost history, and refuses a meter that does not exist', async () => {
    const h = harness(TENANT);
    const lines = await h.costs.meterCosts(actor);
    expect(lines).toEqual([{ meterKey: 'api.calls', unit: 'count', nameKey: 'n', costs: [expect.objectContaining({ amount: '0.05', unitSize: '1000', currencyCode: 'IRT' })] }]);
    await expect(h.costs.setMeterCost(actor, { meterKey: 'nope', unitSize: '1', unitCost: '1' })).rejects.toMatchObject({ reason: 'meter_not_found' });
  });
});

describe('CatalogCostService, a cost taken back (F-1002-i)', () => {
  it("writes a variant's 'no cost from now' as a new row with no amount, audited apart, its days restated", async () => {
    const h = harness(TENANT);
    const view = await h.costs.unsetVariantCost(actor, VARIANT, {});
    expect(view).toMatchObject({ amount: null, currencyCode: 'IRT' });
    expect(h.written[0]).toMatchObject({ tenantId: TENANT, variantId: VARIANT, amount: null });
    expect(h.audits).toEqual(['catalog_variant_cost_unset']);
    expect(h.restated).toHaveLength(1);
  });

  it("writes a meter's the same way — neither a unit size nor a unit cost — and refuses a meter that does not exist", async () => {
    const h = harness(TENANT);
    const view = await h.costs.unsetMeterCost(actor, { meterKey: 'api.calls' });
    expect(view).toMatchObject({ amount: null, unitSize: null });
    expect(h.written[0]).toMatchObject({ tenantId: TENANT, meterKey: 'api.calls', unitSize: null, unitCost: null });
    expect(h.audits).toEqual(['catalog_meter_cost_unset']);
    await expect(h.costs.unsetMeterCost(actor, { meterKey: 'nope' })).rejects.toMatchObject({ reason: 'meter_not_found' });
  });

  it('refuses at the edge a take-back from a closed month, and one on vpn.traffic', () => {
    expect(unsetVariantCostSchema.safeParse({ effectiveFrom: '2020-01-01T00:00:00Z' }).success).toBe(false);
    expect(unsetVariantCostSchema.safeParse({}).success).toBe(true);
    expect(unsetMeterCostSchema.safeParse({ meterKey: METER_KEYS.vpnTraffic }).success).toBe(false);
  });
});

describe('the cost routes refuse at the edge', () => {
  it('a unit cost on vpn.traffic, and a cost from before this month', () => {
    expect(setMeterCostSchema.safeParse({ meterKey: METER_KEYS.vpnTraffic, unitSize: '1', unitCost: '1' }).success).toBe(false);
    expect(setMeterCostSchema.safeParse({ meterKey: 'api.calls', unitSize: '1000', unitCost: '0.05' }).success).toBe(true);
    expect(setVariantCostSchema.safeParse({ amount: '1.00', effectiveFrom: '2020-01-01T00:00:00Z' }).success).toBe(false);
    expect(setVariantCostSchema.safeParse({ amount: '0' }).success).toBe(true);
  });
});
