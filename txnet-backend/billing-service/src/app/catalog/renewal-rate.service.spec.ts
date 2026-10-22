/**
 * A product's renewal rate (F-305-b, ADR-0158 (4)-(6)) — the service around
 * the catalog's door, and the edge's shape rules.
 *
 * The ways this goes wrong quietly:
 *
 *  - **another tenant's product priced.** The catalog's door answers not
 *    found, and nothing is written;
 *  - **a rate in the wrong currency.** It is written in its tenant's pricing
 *    currency, as a price is, and read only in it: a row in another is no rate;
 *  - **"off" read as the older rate.** Switching off is the newest row, with
 *    no prices; the rate in effect is then none, not the one before it;
 *  - **a part sold for nothing, or bounds that buy nothing.** The edge refuses
 *    them before a CHECK has to.
 */
import { Prisma } from '@prisma/client';

import { CatalogActor, CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';
import { offRenewalRateSchema, setRenewalRateSchema } from './renewal-rate.schema';
import { RenewalRateService } from './renewal-rate.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '55555555-5555-4555-8555-5555555555a1';
const actor: CatalogActor = { adminId: '33333333-3333-4333-8333-333333333333', tenantId: TENANT, ip: '127.0.0.1', permissions: ['catalog.manage'] };
const AT = new Date('2026-10-22T10:00:00Z');
const TERMS = { pricePerGib: '1500', pricePerDay: '300.5', minGib: 1, maxGib: 200, minDays: 0, maxDays: 90 };

type Row = Record<string, unknown>;
const row = (over: Row): Row => ({
  id: 'r0',
  tenantId: TENANT,
  productId: PRODUCT,
  pricePerGib: null,
  pricePerDay: null,
  minGib: null,
  maxGib: null,
  minDays: null,
  maxDays: null,
  currencyCode: 'IRT',
  effectiveFrom: AT,
  createdAt: AT,
  ...over,
});

function harness(productTenant: string, existing: Row[] = []) {
  const written: Row[] = [];
  const audits: string[] = [];
  const asked: Row[] = [];
  const tx = {
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'IRT' }) },
    renewalRate: {
      create: async ({ data }: { data: Row }) => (written.push(data), row({ id: 'r9', ...data })),
      findMany: async () => existing,
      findFirst: async ({ where }: { where: Row }) => (asked.push(where), existing[0] ?? null),
    },
  };
  const door = {
    access: async () => ({ owner: false }),
    within: (_owner: boolean, fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
    managed: async (_db: unknown, _model: string, missing: 'product_not_found', a: CatalogActor, id: string) => {
      if (productTenant !== a.tenantId) throw new CatalogAdminRefused(missing, id);
      return { id, tenantId: productTenant };
    },
    effectiveFrom: (requested?: string) => (requested ? new Date(requested) : AT),
    audit: async (_tx: unknown, _a: unknown, _t: unknown, action: string) => void audits.push(action),
  } as unknown as CatalogAdminService;
  return { rates: new RenewalRateService(door), written, audits, asked };
}

describe('RenewalRateService', () => {
  it("writes a rate in its product's tenant's pricing currency, audited", async () => {
    const h = harness(TENANT);
    const view = await h.rates.set(actor, PRODUCT, TERMS);
    expect(h.written[0]).toMatchObject({ tenantId: TENANT, productId: PRODUCT, currencyCode: 'IRT', minGib: 1, maxGib: 200, effectiveFrom: AT });
    expect(h.written[0]?.['pricePerGib']).toEqual(new Prisma.Decimal('1500'));
    expect(view).toMatchObject({ pricePerGib: '1500', pricePerDay: '300.5', maxDays: 90, currencyCode: 'IRT', isOff: false });
    expect(h.audits).toEqual(['catalog_renewal_rate_set']);
  });

  it('switches custom renewal off with a row that has no prices and no bounds', async () => {
    const h = harness(TENANT);
    const view = await h.rates.off(actor, PRODUCT, {});
    expect(h.written[0]).toMatchObject({ pricePerGib: null, pricePerDay: null, minGib: null, maxGib: null, minDays: null, maxDays: null });
    expect(view.isOff).toBe(true);
    expect(h.audits).toEqual(['catalog_renewal_rate_off']);
  });

  it("refuses another tenant's product, or the platform's to a reseller, writing nothing", async () => {
    const h = harness(OTHER);
    await expect(h.rates.set(actor, PRODUCT, TERMS)).rejects.toMatchObject({ reason: 'product_not_found' });
    expect(h.written).toEqual([]);
  });

  it('answers the rate in effect in the tenant currency, and none when the newest row is off', async () => {
    const priced = row({ id: 'r1', pricePerGib: new Prisma.Decimal('1500'), pricePerDay: new Prisma.Decimal('300'), minGib: 1, maxGib: 200, minDays: 0, maxDays: 90 });
    const on = await harness(TENANT, [priced]).rates.rates(actor, PRODUCT);
    expect(on.inEffect).toMatchObject({ id: 'r1', pricePerGib: '1500', isOff: false });

    const h = harness(TENANT, [row({ id: 'r2' }), priced]);
    const off = await h.rates.rates(actor, PRODUCT);
    expect(off.inEffect).toBeNull();
    expect(off.history.map((r) => r.id)).toEqual(['r2', 'r1']);
    // Only a row in the reader's currency is a rate (catalog invariant 11), and only one already in effect.
    expect(h.asked[0]).toMatchObject({ productId: PRODUCT, currencyCode: 'IRT', effectiveFrom: { lte: expect.any(Date) } });
  });
});

describe('the renewal rate schema', () => {
  const refusal = (body: unknown) => setRenewalRateSchema.safeParse(body).error?.issues.map((i) => i.message);

  it('takes a whole rate, and an off with only a moment', () => {
    expect(setRenewalRateSchema.safeParse(TERMS).success).toBe(true);
    expect(offRenewalRateSchema.safeParse({ effectiveFrom: '2026-11-01T00:00:00Z' }).success).toBe(true);
    expect(offRenewalRateSchema.safeParse({ pricePerGib: '1' }).success).toBe(false);
  });

  it('refuses bounds that buy nothing, a minimum above its maximum, and a sold part at 0', () => {
    expect(refusal({ ...TERMS, maxGib: 0, maxDays: 0, minGib: 0 })).toContain('renewal_sells_nothing');
    expect(refusal({ ...TERMS, minDays: 100 })).toContain('renewal_bounds_reversed');
    expect(refusal({ ...TERMS, pricePerGib: '0' })).toContain('renewal_sold_part_free');
    // A part not sold may cost 0: its maximum of 0 already says it is not sold.
    expect(setRenewalRateSchema.safeParse({ ...TERMS, pricePerGib: '0', minGib: 0, maxGib: 0 }).success).toBe(true);
  });

  it('refuses a price finer than its column and a bound past the typo guard', () => {
    expect(setRenewalRateSchema.safeParse({ ...TERMS, pricePerDay: '0.123456789' }).success).toBe(false);
    expect(setRenewalRateSchema.safeParse({ ...TERMS, maxDays: 1_000_000 }).success).toBe(false);
  });
});
