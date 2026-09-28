/**
 * The catalog's storage (F-026-a, D-34, ADR-0049), against a real Postgres
 * built from the committed migration history.
 *
 * Only a database can say any of it: a tenant reads the platform's catalog and
 * its own through Row-Level Security; a price row is never rewritten, because
 * yesterday's invoice is computed at yesterday's price (F-0602); a variant and
 * its prices belong to their product's tenant, and go with it only when
 * nothing references the variant (F-026-h); a SKU is unique inside a tenant;
 * a coupon's service scope names exactly one product or one variant; and a
 * capability's key is unique among what one tenant sees, while a product's
 * `featureKeys` is checked under a lock the service's raw SQL takes (F-114-f-a).
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { PrismaService } from '../prisma/prisma.service';
import { CatalogAdminRefused, CatalogAdminService } from './catalog-admin.service';
import type { CatalogTextService } from './catalog-texts';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

const CATEGORY = '44444444-4444-4444-8444-4444444444a1';
const PLATFORM_PRODUCT = '44444444-4444-4444-8444-4444444444b1';
const A_PRODUCT = '44444444-4444-4444-8444-4444444444b2';
const B_PRODUCT = '44444444-4444-4444-8444-4444444444b3';
const PLATFORM_VARIANT = '44444444-4444-4444-8444-4444444444c1';
const A_VARIANT = '44444444-4444-4444-8444-4444444444c2';
const B_VARIANT = '44444444-4444-4444-8444-4444444444c3';
const PLATFORM_PRICE = '44444444-4444-4444-8444-4444444444d1';
const COUPON = '44444444-4444-4444-8444-4444444444e1';

let pg: PostgresFixture;
let owner: PrismaClient;
let cross: PrismaClient;
let app: PrismaService;

const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);

async function insertProduct(id: string, tenantId: string | null, key: string, categoryId = CATEGORY) {
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind")
    VALUES ('${id}', ${q(tenantId)}, '${key}', 'catalog.product.${key}.name', 'network_access')
  `);
  await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category_link ("productId", "categoryId", "tenantId") SELECT id, '${categoryId}', "tenantId" FROM catalog.product WHERE id = '${id}'`);
}

async function insertVariant(id: string, tenantId: string | null, productId: string, sku: string) {
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, quotas)
    VALUES ('${id}', ${q(tenantId)}, '${productId}', '${sku}', 'prepaid', 'public', '{}')
  `);
}

async function insertPrice(id: string, tenantId: string | null, variantId: string, amount: string) {
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom")
    VALUES ('${id}', ${q(tenantId)}, '${variantId}', ${amount}, 'USD', now())
  `);
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  cross = prismaAt(pg.crossTenantUrl);

  for (const [id, type, slug] of [
    [PLATFORM, 'platform_owner', 'home'],
    [RESELLER_A, 'reseller', 'alpha'],
    [RESELLER_B, 'reseller', 'beta'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product_category (id, "tenantId", key, "nameKey") VALUES ('${CATEGORY}', NULL, 'vpn', 'catalog.category.vpn.name')
  `);
  await insertProduct(PLATFORM_PRODUCT, null, 'vpn_basic');
  await insertProduct(A_PRODUCT, RESELLER_A, 'vpn_alpha');
  await insertProduct(B_PRODUCT, RESELLER_B, 'vpn_beta');
  await insertVariant(PLATFORM_VARIANT, null, PLATFORM_PRODUCT, 'VPN-30');
  await insertVariant(A_VARIANT, RESELLER_A, A_PRODUCT, 'VPN-30');
  await insertVariant(B_VARIANT, RESELLER_B, B_PRODUCT, 'VPN-30');
  await insertPrice(PLATFORM_PRICE, null, PLATFORM_VARIANT, '5.00');
  await insertPrice('44444444-4444-4444-8444-4444444444d2', RESELLER_A, A_VARIANT, '6.00');
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "createdByAdminId", "currencyCode")
    VALUES ('${COUPON}', NULL, 'SCOPED', 'percentage', 10.00, '${ADMIN}', 'USD')
  `);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect(), cross?.$disconnect()]);
  await pg?.stop();
});

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

describe("whose catalog a tenant reads", () => {
  it("reads the platform's products, variants and prices and its own — never another tenant's", async () => {
    const seen = await asTenant(RESELLER_A, async (tx) => ({
      products: (await tx.product.findMany({ select: { id: true } })).map((p) => p.id).sort(),
      variants: (await tx.productVariant.findMany({ select: { id: true } })).map((v) => v.id).sort(),
      prices: await tx.price.count(),
    }));

    expect(seen.products).toEqual([PLATFORM_PRODUCT, A_PRODUCT].sort());
    expect(seen.variants).toEqual([PLATFORM_VARIANT, A_VARIANT].sort());
    expect(seen.prices).toBe(2);
  });

  it("cannot write a platform product from a tenant's connection", async () => {
    await expect(
      asTenant(RESELLER_A, (tx) =>
        tx.product.create({
          data: { tenantId: null, key: 'sneaky', nameKey: 'k', fulfilmentKind: 'network_access' },
        }),
      ),
    ).rejects.toThrow(/row-level security|42501/);
  });
});

describe('a price row is history', () => {
  it('is never re-priced, moved or deleted', async () => {
    await expect(cross.$executeRawUnsafe(`UPDATE catalog.price SET amount = 1.00 WHERE id = '${PLATFORM_PRICE}'`)).rejects.toThrow(
      /price_is_history/,
    );
    await expect(
      cross.$executeRawUnsafe(`UPDATE catalog.price SET "effectiveFrom" = now() - interval '1 day' WHERE id = '${PLATFORM_PRICE}'`),
    ).rejects.toThrow(/price_is_history/);
    await expect(cross.$executeRawUnsafe(`DELETE FROM catalog.price WHERE id = '${PLATFORM_PRICE}'`)).rejects.toThrow(/price_is_history/);
  });

  it('may be switched off', async () => {
    await expect(
      cross.$executeRawUnsafe(`UPDATE catalog.price SET "isActive" = false WHERE id = '${PLATFORM_PRICE}'`),
    ).resolves.toBe(1);
  });
});

describe('a variant nothing references can be deleted, and its prices go with it (F-026-h)', () => {
  const SPARE_PRODUCT = '44444444-4444-4444-8444-4444444444b4';
  const SPARE_VARIANT = '44444444-4444-4444-8444-4444444444c4';
  const SPARE_PRICE = '44444444-4444-4444-8444-4444444444d4';
  const SOLD_PRODUCT = '44444444-4444-4444-8444-4444444444b5';
  const SOLD_VARIANT = '44444444-4444-4444-8444-4444444444c5';

  it("deletes a tenant's unreferenced variant with its price, from the tenant's own connection", async () => {
    await insertProduct(SPARE_PRODUCT, RESELLER_A, 'vpn_spare');
    await insertVariant(SPARE_VARIANT, RESELLER_A, SPARE_PRODUCT, 'VPN-SPARE');
    await insertPrice(SPARE_PRICE, RESELLER_A, SPARE_VARIANT, '3.00');
    await expect(cross.$executeRawUnsafe(`DELETE FROM catalog.price WHERE id = '${SPARE_PRICE}'`)).rejects.toThrow(/price_is_history/);

    await asTenant(RESELLER_A, async (tx) => {
      await tx.productVariant.deleteMany({ where: { productId: SPARE_PRODUCT } });
      await tx.product.delete({ where: { id: SPARE_PRODUCT } });
    });
    await expect(owner.price.count({ where: { id: SPARE_PRICE } })).resolves.toBe(0);
  });

  it('refuses the delete of a variant something references — RESTRICT, 23001 — and keeps its price', async () => {
    await insertProduct(SOLD_PRODUCT, RESELLER_A, 'vpn_sold');
    await insertVariant(SOLD_VARIANT, RESELLER_A, SOLD_PRODUCT, 'VPN-SOLD');
    await insertPrice('44444444-4444-4444-8444-4444444444d5', RESELLER_A, SOLD_VARIANT, '4.00');
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon_service_scope (id, "couponId", "productId", "variantId")
      VALUES (gen_random_uuid(), '${COUPON}', NULL, '${SOLD_VARIANT}')
    `);
    // Prisma leaves 23001 unmapped; `isStillReferenced` in catalog-admin.service.ts reads it from the message.
    await expect(asTenant(RESELLER_A, (tx) => tx.productVariant.deleteMany({ where: { productId: SOLD_PRODUCT } }))).rejects.toThrow(
      /code: "23001"/,
    );
    await expect(owner.price.count({ where: { variantId: SOLD_VARIANT } })).resolves.toBe(1);
  });
});

describe('a category goes only when no product sits in it (F-026-j)', () => {
  const EMPTY = '44444444-4444-4444-8444-4444444444a6';
  const HELD = '44444444-4444-4444-8444-4444444444a7';
  const ARCHIVED_PRODUCT = '44444444-4444-4444-8444-4444444444b7';

  it('deletes an empty category and refuses one an archived product still sits in — RESTRICT, 23001', async () => {
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product_category (id, "tenantId", key, "nameKey") VALUES
        ('${EMPTY}', '${RESELLER_A}', 'empty', 'catalog.category.empty.name'),
        ('${HELD}', '${RESELLER_A}', 'held', 'catalog.category.held.name')
    `);
    await insertProduct(ARCHIVED_PRODUCT, RESELLER_A, 'vpn_archived', HELD);
    await owner.$executeRawUnsafe(`UPDATE catalog.product SET "isActive" = false, "archivedAt" = now() WHERE id = '${ARCHIVED_PRODUCT}'`);

    await asTenant(RESELLER_A, (tx) => tx.productCategory.delete({ where: { id: EMPTY } }));
    // `has_products` in catalog-admin.service.ts is this refusal, read by `isStillReferenced`.
    await expect(asTenant(RESELLER_A, (tx) => tx.productCategory.delete({ where: { id: HELD } }))).rejects.toThrow(/code: "23001"/);
    await expect(owner.productCategory.count({ where: { id: { in: [EMPTY, HELD] } } })).resolves.toBe(1);
  });
});

describe("a variant and its prices are their product's tenant's", () => {
  it("refuses a tenant's variant under the platform's product", async () => {
    await expect(insertVariant('44444444-4444-4444-8444-4444444444c9', RESELLER_A, PLATFORM_PRODUCT, 'STOLEN')).rejects.toThrow(
      /catalog_tenant_mismatch/,
    );
  });

  it("refuses a price whose tenant is not its variant's", async () => {
    await expect(insertPrice('44444444-4444-4444-8444-4444444444d9', RESELLER_B, A_VARIANT, '1.00')).rejects.toThrow(
      /catalog_tenant_mismatch/,
    );
  });
});

describe('a SKU is unique inside a tenant', () => {
  it('lets the platform and two tenants each sell VPN-30, but not one tenant twice', async () => {
    await expect(owner.productVariant.count({ where: { sku: 'VPN-30' } })).resolves.toBe(3);
    await expect(insertVariant('44444444-4444-4444-8444-4444444444ca', RESELLER_A, A_PRODUCT, 'VPN-30')).rejects.toThrow(
      /Unique constraint|23505/,
    );
    await expect(insertVariant('44444444-4444-4444-8444-4444444444cb', null, PLATFORM_PRODUCT, 'VPN-30')).rejects.toThrow(
      /Unique constraint|23505/,
    );
  });
});

describe("a coupon's service scope", () => {
  it('names exactly one product or one variant', async () => {
    const scope = (productId: string | null, variantId: string | null) =>
      owner.$executeRawUnsafe(`
        INSERT INTO billing.coupon_service_scope (id, "couponId", "productId", "variantId")
        VALUES (gen_random_uuid(), '${COUPON}', ${q(productId)}, ${q(variantId)})
      `);

    await expect(scope(PLATFORM_PRODUCT, null)).resolves.toBe(1);
    await expect(scope(null, PLATFORM_VARIANT)).resolves.toBe(1);
    await expect(scope(null, null)).rejects.toThrow(/coupon_service_scope_names_one/);
    await expect(scope(PLATFORM_PRODUCT, PLATFORM_VARIANT)).rejects.toThrow(/coupon_service_scope_names_one/);
  });
});

describe('capabilities are catalog rows (F-114-f-a, ADR-0086)', () => {
  const capability = (tenantId: string | null, key: string) =>
    owner.$executeRawUnsafe(`INSERT INTO catalog.product_capability (id, "tenantId", key, "nameKey") VALUES (gen_random_uuid(), ${q(tenantId)}, '${key}', 'n')`);

  beforeAll(async () => {
    await capability(null, 'vpn.access');
    await capability(RESELLER_A, 'alpha.extra');
    await capability(RESELLER_B, 'beta.only');
  });

  it("are read shared: a tenant sees the platform's and its own, and writes no platform row", async () => {
    const keys = await asTenant(RESELLER_A, async (tx) => (await tx.productCapability.findMany({ select: { key: true } })).map((c) => c.key).sort());
    expect(keys).toEqual(['alpha.extra', 'vpn.access']);
    await expect(asTenant(RESELLER_A, (tx) => tx.productCapability.create({ data: { tenantId: null, key: 'vpn.new', nameKey: 'n' } }))).rejects.toThrow();
  });

  it("refuses a tenant key the platform holds, and a platform key a tenant holds — one tenant would see it twice", async () => {
    await expect(capability(RESELLER_A, 'vpn.access')).rejects.toThrow(/capability_key_taken/);
    await expect(capability(null, 'beta.only')).rejects.toThrow(/capability_key_taken/);
    await expect(capability(RESELLER_B, 'alpha.extra')).resolves.toBe(1);
  });

  it("lets a tenant's product carry the platform's and its own keys and refuses another tenant's, through the service's locking SQL", async () => {
    const texts = { defaultLanguage: () => 'fa', languages: () => ['fa'], publishSources: async () => undefined, clear: async () => undefined };
    const service = new CatalogAdminService(app, cross as unknown as never, texts as unknown as CatalogTextService);
    const as = { adminId: ADMIN, tenantId: RESELLER_A, ip: '10.0.0.1' };
    const input = { categoryIds: [CATEGORY], name: { fa: 'x' }, fulfilmentKind: 'network_access' as const };
    const create = (key: string, featureKeys: string[]) => runWithTenant({ id: RESELLER_A }, () => service.createProduct(as, { ...input, key, featureKeys }));

    await expect(create('vpn_caps', ['vpn.access', 'alpha.extra'])).resolves.toMatchObject({ featureKeys: ['vpn.access', 'alpha.extra'] });
    const refused = await create('vpn_foreign', ['beta.only']).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CatalogAdminRefused);
    expect((refused as CatalogAdminRefused).reason).toBe('capability_unknown');
    // Held now: the delete's row lock and count run on the same database.
    const id = (await owner.productCapability.findFirstOrThrow({ where: { tenantId: RESELLER_A, key: 'alpha.extra' } })).id;
    const held = await runWithTenant({ id: RESELLER_A }, () => service.removeCapability(as, id)).catch((e: unknown) => e);
    expect((held as CatalogAdminRefused).reason).toBe('capability_in_use');
  });
});
