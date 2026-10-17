/**
 * A product's cost (F-1002-d, ADR-0151), against a real Postgres built from
 * the committed migration history.
 *
 * Only a database can say any of it: a cost is **private to its tenant** —
 * unlike every other catalog row, a reseller never reads the platform's (what
 * the platform pays its suppliers is not a reseller's to see); a cost is
 * history, never changed, and goes only with its variant; a variant's cost
 * carries its variant's tenant; and `vpn.traffic` takes no unit cost, because
 * its cost is its panels'. A cost is taken back with a row that has none
 * (F-1002-i): the history keeps both, and what analytics reads after it is
 * "not set", not 0.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { METER_KEYS, runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import { HARNESS_TIMEOUT_MS, PostgresFixture, prismaAt, startPostgresFixture } from '../../../../test-support/postgres-fixture';
import { dayBounds } from '../analytics/analytics-days';
import { readOwnCosts } from '../analytics/analytics-rollup-own-cost';
import { PrismaService } from '../prisma/prisma.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER = '11111111-1111-4111-8111-111111111111';
const PLATFORM_PRODUCT = '44444444-4444-4444-8444-4444444444b1';
const RESELLER_PRODUCT = '44444444-4444-4444-8444-4444444444b2';
const PLATFORM_VARIANT = '44444444-4444-4444-8444-4444444444c1';
const RESELLER_VARIANT = '44444444-4444-4444-8444-4444444444c2';
const PLATFORM_COST = '55555555-5555-4555-8555-5555555555a1';
const METER = 'harness.calls';

let pg: PostgresFixture;
let owner: PrismaClient;
let cross: PrismaClient;
let app: PrismaService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  cross = prismaAt(pg.crossTenantUrl);
  for (const [id, type, slug] of [
    [PLATFORM, 'platform_owner', 'home'],
    [RESELLER, 'reseller', 'alpha'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())`);
  }
  for (const [product, variant, tenant, key] of [
    [PLATFORM_PRODUCT, PLATFORM_VARIANT, PLATFORM, 'api'],
    [RESELLER_PRODUCT, RESELLER_VARIANT, RESELLER, 'ip'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind") VALUES ('${product}', '${tenant}', '${key}', 'k', 'feature_access')`);
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, quotas)
      VALUES ('${variant}', '${tenant}', '${product}', 'SKU-1', 'prepaid', 'public', '{}')`);
  }
  await owner.$executeRawUnsafe(`INSERT INTO catalog.meter (id, key, unit, "reportedBy", "nameKey") VALUES (gen_random_uuid(), '${METER}', 'count', 'harness', 'k')`);
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.variant_cost (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom")
    VALUES ('${PLATFORM_COST}', '${PLATFORM}', '${PLATFORM_VARIANT}', 2.00, 'USD', now())`);
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.meter_cost (id, "tenantId", "meterKey", "unitSize", "unitCost", "currencyCode", "effectiveFrom")
    VALUES (gen_random_uuid(), '${PLATFORM}', '${METER}', 1000, 0.05, 'USD', now())`);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect(), cross?.$disconnect()]);
  await pg?.stop();
});

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

describe("a cost is its tenant's alone", () => {
  it("is never read by a reseller, though the platform's catalog is", async () => {
    const seen = await asTenant(RESELLER, async (tx) => ({
      variants: await tx.productVariant.count(),
      variantCosts: await tx.variantCost.count(),
      meterCosts: await tx.meterCost.count(),
    }));
    expect(seen).toEqual({ variants: 2, variantCosts: 0, meterCosts: 0 });
  });

  it("is written on the tenant's own variant only, carrying its tenant", async () => {
    await expect(
      asTenant(RESELLER, (tx) => tx.variantCost.create({ data: { tenantId: RESELLER, variantId: RESELLER_VARIANT, amount: '1.50', currencyCode: 'USD', effectiveFrom: new Date() } })),
    ).resolves.toMatchObject({ tenantId: RESELLER });
    // RLS writes its own tenant; the trigger, that it is the variant's.
    await expect(
      asTenant(RESELLER, (tx) => tx.variantCost.create({ data: { tenantId: RESELLER, variantId: PLATFORM_VARIANT, amount: '1.00', currencyCode: 'USD', effectiveFrom: new Date() } })),
    ).rejects.toThrow(/catalog_tenant_mismatch/);
  });
});

describe('a cost is history', () => {
  it('is never changed or deleted', async () => {
    await expect(cross.$executeRawUnsafe(`UPDATE catalog.variant_cost SET amount = 9 WHERE id = '${PLATFORM_COST}'`)).rejects.toThrow(/cost_is_history/);
    await expect(cross.$executeRawUnsafe(`DELETE FROM catalog.variant_cost WHERE id = '${PLATFORM_COST}'`)).rejects.toThrow(/cost_is_history/);
    await expect(cross.$executeRawUnsafe(`UPDATE catalog.meter_cost SET "unitCost" = 9`)).rejects.toThrow(/cost_is_history/);
    await expect(cross.$executeRawUnsafe(`DELETE FROM catalog.meter_cost`)).rejects.toThrow(/cost_is_history/);
  });

  it('goes with its variant', async () => {
    await owner.$executeRawUnsafe(`DELETE FROM catalog.product_variant WHERE id = '${PLATFORM_VARIANT}'`);
    expect(await cross.variantCost.count({ where: { id: PLATFORM_COST } })).toBe(0);
  });
});

describe('a meter cost', () => {
  it('is never set on vpn.traffic — its cost is its panels', async () => {
    await expect(
      cross.$executeRawUnsafe(`
        INSERT INTO catalog.meter_cost (id, "tenantId", "meterKey", "unitSize", "unitCost", "currencyCode", "effectiveFrom")
        VALUES (gen_random_uuid(), '${PLATFORM}', '${METER_KEYS.vpnTraffic}', 1073741824, 0.01, 'USD', now())`),
    ).rejects.toThrow(/meter_cost_not_vpn_traffic/);
  });
});

describe('a cost taken back (F-1002-i)', () => {
  const ROLE = '66666666-6666-4666-8666-666666666601';
  const BUYER = '66666666-6666-4666-8666-666666666602';
  const PRICE = '66666666-6666-4666-8666-666666666603';
  const sale = async (invoice: string, at: string) => {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.invoice (id, "tenantId", "userId", "variantId", "priceId", amount, discount, total, "currencyCode", status, "expiresAt", "createdAt")
      VALUES ('${invoice}', '${RESELLER}', '${BUYER}', '${RESELLER_VARIANT}', '${PRICE}', 5, 0, 5, 'USD', 'paid', '${at}', '${at}')`);
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "createdAt")
      VALUES (gen_random_uuid(), '${BUYER}', '${RESELLER}', 5, 'debit', 'product_purchase', '${invoice}', 0, 'USD', '${at}')`);
  };

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
    await owner.$executeRawUnsafe(`INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt") VALUES ('${BUYER}', '${RESELLER}', 'Buyer', 'x', '${ROLE}', now())`);
    await owner.$executeRawUnsafe(`INSERT INTO billing.wallet (id, "ownerUserId", "cachedBalance", version, "currencyCode") VALUES ('${BUYER}', '${BUYER}', 0, 0, 'USD')`);
    await owner.$executeRawUnsafe(`INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom") VALUES ('${PRICE}', '${RESELLER}', '${RESELLER_VARIANT}', 5, 'USD', '2026-01-01')`);
  });

  it('is a row with no amount — a meter row with neither unit size nor unit cost, never one of the two', async () => {
    await expect(
      asTenant(RESELLER, (tx) => tx.variantCost.create({ data: { tenantId: RESELLER, variantId: RESELLER_VARIANT, amount: null, currencyCode: 'USD', effectiveFrom: new Date('2026-10-10T00:00:00Z') } })),
    ).resolves.toMatchObject({ amount: null });
    await expect(
      cross.$executeRawUnsafe(`INSERT INTO catalog.meter_cost (id, "tenantId", "meterKey", "unitSize", "unitCost", "currencyCode", "effectiveFrom") VALUES (gen_random_uuid(), '${PLATFORM}', '${METER}', NULL, NULL, 'USD', now())`),
    ).resolves.toBe(1);
    await expect(
      cross.$executeRawUnsafe(`INSERT INTO catalog.meter_cost (id, "tenantId", "meterKey", "unitSize", "unitCost", "currencyCode", "effectiveFrom") VALUES (gen_random_uuid(), '${PLATFORM}', '${METER}', 1000, NULL, 'USD', now())`),
    ).rejects.toThrow(/meter_cost_unset_whole/);
  });

  it('costs a sale before it, and reads one after it as not set — no row, so noCost, never 0', async () => {
    // 1.50 from 10-01, taken back from 10-10 (the row above): the 10-05 sale costs 1.50, the 10-12 one is not set.
    await asTenant(RESELLER, (tx) => tx.variantCost.create({ data: { tenantId: RESELLER, variantId: RESELLER_VARIANT, amount: '1.50', currencyCode: 'USD', effectiveFrom: new Date('2026-10-01T00:00:00Z') } }));
    await sale('66666666-6666-4666-8666-6666666666a1', '2026-10-05T08:00:00Z');
    await sale('66666666-6666-4666-8666-6666666666a2', '2026-10-12T08:00:00Z');
    const range = { fromDay: '2026-10-01', toDay: '2026-10-15', zone: 'UTC', ...dayBounds('2026-10-01', '2026-10-15', 'UTC') };
    const rows = await asTenant(RESELLER, (tx) => readOwnCosts(tx, range));
    expect(rows.map((r) => [r.day, r.kind, r.cost.toFixed(2)])).toEqual([['2026-10-05', 'sale', '1.50']]);
  });
});
