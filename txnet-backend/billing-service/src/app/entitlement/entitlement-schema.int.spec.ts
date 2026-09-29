/**
 * The Grant's storage (F-026-b, D-34, ADR-0049), against a real Postgres built
 * from the committed migration history. Spec: `tools/spec.py --section 4.4`.
 *
 * Only a database can hold any of it for every writer at once: a tenant reads
 * only its own Grants; a Grant is issued from the platform's variant or its own
 * tenant's, to a user of its own tenant; its status moves one way (only
 * `suspended → active` returns); the stored subscription token is a SHA-256,
 * never the token; and a quota adjustment is history, on its Grant's tenant.
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

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ROLE = '33333333-3333-4333-8333-333333333333';
const USER_A = '55555555-5555-4555-8555-5555555555a1';
const USER_B = '55555555-5555-4555-8555-5555555555b1';

const CATEGORY = '66666666-6666-4666-8666-6666666666a1';
const PLATFORM_PRODUCT = '66666666-6666-4666-8666-6666666666b1';
const B_PRODUCT = '66666666-6666-4666-8666-6666666666b2';
const PLATFORM_VARIANT = '66666666-6666-4666-8666-6666666666c1';
const B_VARIANT = '66666666-6666-4666-8666-6666666666c2';

const GRANT_A = '77777777-7777-4777-8777-7777777777a1';
const GRANT_B = '77777777-7777-4777-8777-7777777777b1';

let pg: PostgresFixture;
let owner: PrismaClient;
let cross: PrismaClient;
let app: PrismaService;

const hash = (n: number) => n.toString(16).padStart(64, '0');
let tokens = 0;

async function insertGrant(
  id: string,
  tenantId: string,
  userId: string,
  variantId: string,
  over: { status?: string; tokenHash?: string } = {},
) {
  tokens += 1;
  await owner.$executeRawUnsafe(`
    INSERT INTO entitlement."grant" (id, "tenantId", "userId", "variantId", source, status, "startsAt", "billingMode", "subscriptionTokenHash")
    VALUES ('${id}', '${tenantId}', '${userId}', '${variantId}', 'admin_grant', '${over.status ?? 'active'}', now(), 'prepaid',
            '${over.tokenHash ?? hash(tokens)}')
  `);
}

const setStatus = (id: string, status: string) =>
  cross.$executeRawUnsafe(`UPDATE entitlement."grant" SET status = '${status}' WHERE id = '${id}'`);

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  cross = prismaAt(pg.crossTenantUrl);

  await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  for (const [id, type, slug] of [
    [PLATFORM, 'platform_owner', 'home'],
    [TENANT_A, 'reseller', 'alpha'],
    [TENANT_B, 'reseller', 'beta'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  for (const [id, tenantId] of [[USER_A, TENANT_A], [USER_B, TENANT_B]]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${id}', '${tenantId}', 'Someone', 'x', '${ROLE}', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product_category (id, key, "nameKey") VALUES ('${CATEGORY}', 'vpn', 'catalog.category.vpn.name')
  `);
  for (const [id, tenantId, key] of [[PLATFORM_PRODUCT, null, 'vpn_basic'], [B_PRODUCT, TENANT_B, 'vpn_beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind")
      VALUES ('${id}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${key}', 'k', 'network_access')
    `);
    await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category_link ("productId", "categoryId", "tenantId") SELECT id, '${CATEGORY}', "tenantId" FROM catalog.product WHERE id = '${id}'`);
  }
  for (const [id, tenantId, productId] of [[PLATFORM_VARIANT, null, PLATFORM_PRODUCT], [B_VARIANT, TENANT_B, B_PRODUCT]]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility)
      VALUES ('${id}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${productId}', 'VPN-30', 'prepaid', 'public')
    `);
  }
  await insertGrant(GRANT_A, TENANT_A, USER_A, PLATFORM_VARIANT);
  await insertGrant(GRANT_B, TENANT_B, USER_B, B_VARIANT);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect(), cross?.$disconnect()]);
  await pg?.stop();
});

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

describe('whose Grants a tenant reads', () => {
  it('reads only its own — a Grant is never shared-read, not even from the platform', async () => {
    await expect(asTenant(TENANT_A, async (tx) => (await tx.grant.findMany({ select: { id: true } })).map((g) => g.id))).resolves.toEqual([
      GRANT_A,
    ]);
    await expect(asTenant(TENANT_B, async (tx) => (await tx.grant.findMany({ select: { id: true } })).map((g) => g.id))).resolves.toEqual([
      GRANT_B,
    ]);
    await expect(asTenant(PLATFORM, (tx) => tx.grant.count())).resolves.toBe(0);
  });
});

describe('a Grant belongs to its tenant', () => {
  it("refuses a Grant from another tenant's variant", async () => {
    await expect(insertGrant('77777777-7777-4777-8777-7777777777a2', TENANT_A, USER_A, B_VARIANT)).rejects.toThrow(
      /entitlement_tenant_mismatch/,
    );
  });

  it("refuses a Grant to another tenant's user", async () => {
    await expect(insertGrant('77777777-7777-4777-8777-7777777777a3', TENANT_A, USER_B, PLATFORM_VARIANT)).rejects.toThrow(
      /entitlement_tenant_mismatch/,
    );
  });
});

describe("a Grant's status moves one way", () => {
  it('goes pending → active → suspended → active → expired', async () => {
    const id = '77777777-7777-4777-8777-7777777777a4';
    await insertGrant(id, TENANT_A, USER_A, PLATFORM_VARIANT, { status: 'pending' });
    for (const next of ['active', 'suspended', 'active', 'expired']) {
      await expect(setStatus(id, next)).resolves.toBe(1);
    }
  });

  it.each([
    ['expired', 'active'],
    ['exhausted', 'active'],
    ['cancelled', 'suspended'],
    ['expired', 'cancelled'],
    ['active', 'pending'],
  ])('never goes %s → %s', async (from, to) => {
    const id = `77777777-7777-4777-8777-${from.length}${to.length}${'0'.repeat(10)}`.slice(0, 36);
    await insertGrant(id, TENANT_A, USER_A, PLATFORM_VARIANT, { status: from });
    await expect(setStatus(id, to)).rejects.toThrow(/grant_status_one_way/);
  });
});

describe('the subscription token', () => {
  it('is stored as a SHA-256 in hex, once across every Grant', async () => {
    await expect(
      insertGrant('77777777-7777-4777-8777-7777777777a6', TENANT_A, USER_A, PLATFORM_VARIANT, { tokenHash: hash(1) }),
    ).rejects.toThrow(/Unique constraint|23505/);
    await expect(
      insertGrant('77777777-7777-4777-8777-7777777777a7', TENANT_A, USER_A, PLATFORM_VARIANT, { tokenHash: 'a-raw-token' }),
    ).rejects.toThrow(/grant_token_hash_shape/);
  });
});

describe('a quota adjustment', () => {
  const adjust = (id: string, tenantId: string) =>
    owner.$executeRawUnsafe(`
      INSERT INTO entitlement.quota_adjustment (id, "tenantId", "grantId", metric, delta, source)
      VALUES ('${id}', '${tenantId}', '${GRANT_A}', 'traffic_bytes', 1073741824, 'admin_grant')
    `);
  const ADJ = '88888888-8888-4888-8888-8888888888a1';

  it("is on its Grant's tenant", async () => {
    await expect(adjust(ADJ, TENANT_A)).resolves.toBe(1);
    await expect(adjust('88888888-8888-4888-8888-8888888888a2', TENANT_B)).rejects.toThrow(/entitlement_tenant_mismatch/);
  });

  it('is history: never changed or deleted', async () => {
    await expect(cross.$executeRawUnsafe(`UPDATE entitlement.quota_adjustment SET delta = 1 WHERE id = '${ADJ}'`)).rejects.toThrow(
      /quota_adjustment_is_history/,
    );
    await expect(cross.$executeRawUnsafe(`DELETE FROM entitlement.quota_adjustment WHERE id = '${ADJ}'`)).rejects.toThrow(
      /quota_adjustment_is_history/,
    );
  });
});

describe("a Grant's meter (F-118-e, ADR-0105 decision 4)", () => {
  const meter = (id: string, tenantId: string, over = '') =>
    cross.$executeRawUnsafe(`
      INSERT INTO entitlement.grant_meter (id, "tenantId", "grantId", "meterKey", "unitSize", "unitPrice", "currencyCode", mode, "includedQuantity", "afterIncluded")
      VALUES ('${id}', '${tenantId}', '${GRANT_A}', 'vpn.traffic', 1073741824, ${over || '0.4'}, 'USD', 'prepaid', 0, 'metered')
    `);
  const METER = '88888888-8888-4888-8888-8888888888b1';

  it("is on its Grant's tenant, once per meter", async () => {
    await expect(meter(METER, TENANT_A)).resolves.toBe(1);
    await expect(meter('88888888-8888-4888-8888-8888888888b2', TENANT_A)).rejects.toThrow(/grant_meter_grantId_meterKey_key|Unique constraint/);
    await expect(meter('88888888-8888-4888-8888-8888888888b3', TENANT_B)).rejects.toThrow(/entitlement_tenant_mismatch/);
  });

  it('moves its counters, never its terms, and is never deleted', async () => {
    await expect(
      cross.$executeRawUnsafe(`UPDATE entitlement.grant_meter SET consumed = 10, billed = 5, funded = 20 WHERE id = '${METER}'`),
    ).resolves.toBe(1);
    await expect(cross.$executeRawUnsafe(`UPDATE entitlement.grant_meter SET "unitPrice" = 0.1 WHERE id = '${METER}'`)).rejects.toThrow(
      /grant_meter_terms_are_locked/,
    );
    await expect(cross.$executeRawUnsafe(`UPDATE entitlement.grant_meter SET consumed = -1 WHERE id = '${METER}'`)).rejects.toThrow(
      /grant_meter_counters_not_negative/,
    );
    await expect(cross.$executeRawUnsafe(`DELETE FROM entitlement.grant_meter WHERE id = '${METER}'`)).rejects.toThrow(
      /grant_meter_terms_are_locked/,
    );
  });
});
