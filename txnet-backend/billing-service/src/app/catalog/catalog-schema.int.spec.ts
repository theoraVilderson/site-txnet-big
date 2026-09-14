/**
 * The catalog's storage (F-026-a, D-34, ADR-0049), against a real Postgres
 * built from the committed migration history.
 *
 * Only a database can say any of it: a tenant reads the platform's catalog and
 * its own through Row-Level Security; a price row is never rewritten, because
 * yesterday's invoice is computed at yesterday's price (F-0602); a variant and
 * its prices belong to their product's tenant; a SKU is unique inside a tenant;
 * and a coupon's service scope names exactly one product or one variant.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { PrismaService } from '../prisma/prisma.service';

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

async function insertProduct(id: string, tenantId: string | null, key: string) {
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product (id, "tenantId", "categoryId", key, "nameKey", "fulfilmentKind")
    VALUES ('${id}', ${q(tenantId)}, '${CATEGORY}', '${key}', 'catalog.product.${key}.name', 'network_access')
  `);
}

async function insertVariant(id: string, tenantId: string | null, productId: string, sku: string) {
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, quotas)
    VALUES ('${id}', ${q(tenantId)}, '${productId}', '${sku}', 'prepaid', 'public', '{}')
  `);
}

async function insertPrice(id: string, tenantId: string | null, variantId: string, amount: string) {
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "effectiveFrom")
    VALUES ('${id}', ${q(tenantId)}, '${variantId}', ${amount}, now())
  `);
}

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });
  cross = new PrismaClient({ datasourceUrl: pg.crossTenantUrl });

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
    INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "createdByAdminId")
    VALUES ('${COUPON}', NULL, 'SCOPED', 'percentage', 10.00, '${ADMIN}')
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
          data: { tenantId: null, categoryId: CATEGORY, key: 'sneaky', nameKey: 'k', fulfilmentKind: 'network_access' },
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
