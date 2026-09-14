/**
 * Catalog management (F-026-d, D-34, ADR-0049; spec F-0601, F-0602).
 *
 * The class reads and writes on the cross-tenant pool, so the boundary is its
 * own checks, and every way it breaks is silent:
 *
 *  - **ownership.** The platform owner manages platform items and every
 *    tenant's; any other tenant only its own. Another tenant's item is *not
 *    found*, so the surface never confirms it exists;
 *  - **whose category.** A tenant's product sits in its own category or the
 *    platform's shared one, never another tenant's;
 *  - **a price is history.** A change writes a new row and never edits the old;
 *    a price effective in the past is refused, because it would reprice an
 *    invoice already issued; a price is switched off, never deleted;
 *  - **a SKU is unique in its tenant**, and a second one is its own refusal;
 *  - **audit.** Every write leaves a row naming the actor and what changed.
 *
 * What the database holds for every writer is `catalog-schema.int.spec.ts`.
 */
import { FulfilmentKind, Prisma, TenantType, VariantBillingMode, VariantVisibility } from '@prisma/client';

import { CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const PLATFORM_CATEGORY = 'a0000000-0000-4000-8000-000000000001';
const OTHER_CATEGORY = 'a0000000-0000-4000-8000-000000000003';
const PLATFORM_PRODUCT = 'b0000000-0000-4000-8000-000000000001';
const RESELLER_PRODUCT = 'b0000000-0000-4000-8000-000000000002';
const OTHER_PRODUCT = 'b0000000-0000-4000-8000-000000000003';
const RESELLER_VARIANT = 'c0000000-0000-4000-8000-000000000002';
const RESELLER_PRICE = 'd0000000-0000-4000-8000-000000000002';

const actor = (tenantId: string) => ({ adminId: ADMIN, tenantId, ip: '10.0.0.9' });

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row = {}) =>
  Object.entries(where).every(([k, v]) => v === undefined || (row[k] ?? null) === v);

const unique = (message: string) =>
  new Prisma.PrismaClientKnownRequestError(message, { code: 'P2002', clientVersion: 'test' });

function table(rows: Row[], name: string, writes: string[], uniqueOn: string[] = []) {
  let next = 0;
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      if (uniqueOn.length && rows.some((r) => uniqueOn.every((k) => (r[k] ?? null) === (data[k] ?? null)))) {
        throw unique(`${name}: ${uniqueOn.join(', ')}`);
      }
      writes.push(`${name}.create`);
      const row = { id: `e0000000-0000-4000-8000-0000000000${String(next++).padStart(2, '0')}`, isActive: true, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      writes.push(`${name}.update`);
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}: no row`);
      return Object.assign(row, data);
    },
  };
}

function build() {
  const writes: string[] = [];
  const audit: Row[] = [];
  const types: Record<string, TenantType> = { [OWNER]: TenantType.platform_owner, [RESELLER]: TenantType.reseller, [OTHER]: TenantType.reseller };
  const product = (id: string, tenantId: string | null, key: string, categoryId = PLATFORM_CATEGORY): Row => ({
    id, tenantId, categoryId, key, nameKey: `catalog.product.${key}.name`, descriptionKey: null,
    fulfilmentKind: FulfilmentKind.network_access, featureKeys: ['vpn.access'], defaultQuotas: {}, isActive: true,
  });
  const db = {
    tenant: table(Object.entries(types).map(([id, tenantType]) => ({ id, tenantType })), 'tenant', writes),
    productCategory: table(
      [
        { id: PLATFORM_CATEGORY, tenantId: null, key: 'vpn', nameKey: 'catalog.category.vpn.name', isActive: true },
        { id: OTHER_CATEGORY, tenantId: OTHER, key: 'followers', nameKey: 'catalog.category.followers.name', isActive: true },
      ],
      'productCategory',
      writes,
      ['tenantId', 'key'],
    ),
    product: table(
      [product(PLATFORM_PRODUCT, null, 'vpn_basic'), product(RESELLER_PRODUCT, RESELLER, 'vpn_alpha'), product(OTHER_PRODUCT, OTHER, 'followers_1k', OTHER_CATEGORY)],
      'product',
      writes,
      ['tenantId', 'key'],
    ),
    productVariant: table(
      [
        {
          id: RESELLER_VARIANT, tenantId: RESELLER, productId: RESELLER_PRODUCT, sku: 'VPN-30', nameKey: null, quotas: {},
          durationDays: 30, billingMode: VariantBillingMode.prepaid, visibility: VariantVisibility.public, panelGroupId: null,
          qualityTier: 'standard', isActive: true,
        },
      ],
      'productVariant',
      writes,
      ['tenantId', 'sku'],
    ),
    price: table(
      [{ id: RESELLER_PRICE, tenantId: RESELLER, variantId: RESELLER_VARIANT, amount: new Prisma.Decimal('5.00'), effectiveFrom: new Date('2026-01-01T00:00:00Z'), isActive: true, createdByAdminId: ADMIN }],
      'price',
      writes,
    ),
    adminAuditLog: {
      create: async ({ data }: { data: Row }) => {
        writes.push('audit');
        audit.push(data);
        return data;
      },
    },
  };
  const all = { ...db, $transaction: async <T>(fn: (tx: typeof db) => Promise<T>) => fn(db) };
  const app = { tenant: { findUnique: async ({ where }: { where: Row }) => (types[where['id'] as string] ? { tenantType: types[where['id'] as string] } : null) } };
  return { service: new CatalogAdminService(app as never, all as never), db, writes, audit };
}

async function refusal(run: () => Promise<unknown>): Promise<CatalogAdminRefused> {
  try {
    await run();
  } catch (e) {
    if (e instanceof CatalogAdminRefused) return e;
    throw e;
  }
  throw new Error('expected a refusal');
}

const NEW_PRODUCT = { categoryId: PLATFORM_CATEGORY, key: 'vpn_pro', nameKey: 'catalog.product.vpn_pro.name', fulfilmentKind: FulfilmentKind.network_access };
const NEW_VARIANT = { sku: 'VPN-90', billingMode: VariantBillingMode.prepaid, visibility: VariantVisibility.public, durationDays: 90, price: '12.00' };

describe('CatalogAdminService — who manages which item', () => {
  it("refuses a platform product, or another tenant's, to a reseller", async () => {
    const { service, audit } = build();
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, tenantId: null }))).reason).toBe('not_platform_owner');
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, tenantId: OTHER }))).reason).toBe('not_platform_owner');
    expect(audit).toHaveLength(0);
  });

  it("lets the platform owner create a product for another tenant, audited against that tenant", async () => {
    const { service, audit } = build();
    const view = await service.createProduct(actor(OWNER), { ...NEW_PRODUCT, tenantId: OTHER });
    expect(view.tenantId).toBe(OTHER);
    expect(audit).toEqual([expect.objectContaining({ tenantId: OTHER, adminId: ADMIN, action: 'catalog_product_create', targetEntityId: view.id })]);
  });

  it("puts a reseller's product in its own tenant when it names none", async () => {
    const { service } = build();
    await expect(service.createProduct(actor(RESELLER), NEW_PRODUCT)).resolves.toMatchObject({ tenantId: RESELLER });
  });

  it("answers another tenant's product, and the platform's, as not found to a reseller", async () => {
    const { service, writes } = build();
    expect((await refusal(() => service.getProduct(actor(RESELLER), OTHER_PRODUCT))).reason).toBe('product_not_found');
    expect((await refusal(() => service.updateProduct(actor(RESELLER), PLATFORM_PRODUCT, { isActive: false }))).reason).toBe('product_not_found');
    expect(writes).toEqual([]);
  });

  it("refuses a tenant's product in another tenant's category", async () => {
    const { service } = build();
    expect((await refusal(() => service.createProduct(actor(RESELLER), { ...NEW_PRODUCT, categoryId: OTHER_CATEGORY }))).reason).toBe('category_not_found');
  });
});

describe('CatalogAdminService — variants and prices', () => {
  it("gives a variant its product's tenant and writes its first price", async () => {
    const { service, db, audit } = build();
    const view = await service.createVariant(actor(OWNER), RESELLER_PRODUCT, NEW_VARIANT);
    expect(view).toMatchObject({ tenantId: RESELLER, productId: RESELLER_PRODUCT, sku: 'VPN-90' });
    expect(view.prices).toEqual([expect.objectContaining({ amount: '12.00', isActive: true })]);
    expect(db.price.rows.at(-1)).toMatchObject({ tenantId: RESELLER, variantId: view.id });
    expect(audit.map((a) => a['action'])).toEqual(['catalog_variant_create']);
  });

  it('refuses a SKU the tenant already sells', async () => {
    const { service } = build();
    expect((await refusal(() => service.createVariant(actor(RESELLER), RESELLER_PRODUCT, { ...NEW_VARIANT, sku: 'VPN-30' }))).reason).toBe('sku_taken');
  });

  it('writes a price change as a new row and leaves the old one as it was', async () => {
    const { service, db, writes, audit } = build();
    const before = { ...db.price.rows[0] };

    const price = await service.setPrice(actor(RESELLER), RESELLER_VARIANT, { amount: '7.00' });

    expect(price).toMatchObject({ variantId: RESELLER_VARIANT, amount: '7.00', isActive: true });
    expect(db.price.rows).toHaveLength(2);
    expect(db.price.rows[0]).toEqual(before);
    expect(writes).not.toContain('price.update');
    expect(audit.map((a) => a['action'])).toEqual(['catalog_price_set']);
  });

  it('refuses a price effective in the past — it would reprice an invoice already issued', async () => {
    const { service, db } = build();
    const past = await refusal(() => service.setPrice(actor(RESELLER), RESELLER_VARIANT, { amount: '7.00', effectiveFrom: '2020-01-01T00:00:00Z' }));
    expect(past.reason).toBe('price_in_the_past');
    expect(db.price.rows).toHaveLength(1);
    await expect(
      service.setPrice(actor(RESELLER), RESELLER_VARIANT, { amount: '7.00', effectiveFrom: '2099-01-01T00:00:00Z' }),
    ).resolves.toMatchObject({ amount: '7.00' });
  });

  it('switches a price off and never deletes it', async () => {
    const { service, db, writes, audit } = build();
    await expect(service.deactivatePrice(actor(RESELLER), RESELLER_PRICE)).resolves.toMatchObject({ id: RESELLER_PRICE, isActive: false });
    expect(db.price.rows).toHaveLength(1);
    expect(writes.filter((w) => w.startsWith('price.'))).toEqual(['price.update']);
    expect(audit.map((a) => a['action'])).toEqual(['catalog_price_deactivate']);
  });

  it("answers another tenant's variant as not found, to change or to price", async () => {
    const { service } = build();
    expect((await refusal(() => service.setPrice(actor(OTHER), RESELLER_VARIANT, { amount: '1.00' }))).reason).toBe('variant_not_found');
    expect((await refusal(() => service.updateVariant(actor(OTHER), RESELLER_VARIANT, { isActive: false }))).reason).toBe('variant_not_found');
  });
});
