/**
 * Whose a coupon is, and whose users it serves (F-502-a, D-33, ADR-0048),
 * against a real Postgres built from the committed migration history.
 *
 * Only a database can say either: a code is unique inside a tenant through two
 * partial unique indexes, and a platform coupon (`tenantId` NULL) is visible on
 * a tenant's connection only when `billing.platform_coupon_serves` says it
 * serves that tenant — its `coupon_tenant` rows, or with none the platform
 * owner alone.
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
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const RESELLER_A = '11111111-1111-4111-8111-111111111111';
const RESELLER_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

const OWN_ONLY = '77777777-7777-4777-8777-7777777777b1';
const FOR_A = '77777777-7777-4777-8777-7777777777b2';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

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
  await insertCoupon(OWN_ONLY, null, 'HOME10');
  await insertCoupon(FOR_A, null, 'ALPHAGIFT');
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon_tenant (id, "couponId", "tenantId") VALUES (gen_random_uuid(), '${FOR_A}', '${RESELLER_A}')
  `);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

async function insertCoupon(id: string, tenantId: string | null, code: string, deleted = false) {
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "createdByAdminId", "deletedAt", "deletedByAdminId", "currencyCode")
    VALUES ('${id}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${code}', 'percentage', 10.00, '${ADMIN}',
            ${deleted ? 'now()' : 'NULL'}, ${deleted ? `'${ADMIN}'` : 'NULL'}, 'USD')
  `);
}

const visibleCodes = (tenantId: string) =>
  runWithTenant({ id: tenantId }, () =>
    tenantTransaction(app, async (tx: Prisma.TransactionClient) =>
      (await tx.coupon.findMany({ select: { code: true }, orderBy: { code: 'asc' } })).map((c) => c.code),
    ),
  );

describe('a code is unique inside a tenant', () => {
  it('lets two tenants hold the same code', async () => {
    await insertCoupon('77777777-7777-4777-8777-7777777777c1', RESELLER_A, 'NOWRUZ');
    await insertCoupon('77777777-7777-4777-8777-7777777777c2', RESELLER_B, 'NOWRUZ');
    await expect(owner.coupon.count({ where: { code: 'NOWRUZ' } })).resolves.toBe(2);
  });

  it('refuses a second live coupon with the same code in one tenant', async () => {
    await expect(insertCoupon('77777777-7777-4777-8777-7777777777c3', RESELLER_A, 'NOWRUZ')).rejects.toThrow(
      /Unique constraint|23505/,
    );
  });

  it('refuses a second live platform coupon with the same code', async () => {
    await expect(insertCoupon('77777777-7777-4777-8777-7777777777c4', null, 'HOME10')).rejects.toThrow(
      /Unique constraint|23505/,
    );
  });

  it('frees a code once its coupon is soft-deleted', async () => {
    await insertCoupon('77777777-7777-4777-8777-7777777777c5', RESELLER_B, 'YALDA', true);
    await expect(insertCoupon('77777777-7777-4777-8777-7777777777c6', RESELLER_B, 'YALDA')).resolves.toBeUndefined();
  });

  it('refuses a deletion that names no admin', async () => {
    await expect(
      owner.$executeRawUnsafe(`UPDATE billing.coupon SET "deletedAt" = now() WHERE id = '${OWN_ONLY}'`),
    ).rejects.toThrow(/coupon_deleted_by_pair/);
  });
});

describe('whose users a platform coupon serves', () => {
  it('with no tenant rows, only the platform owner sees it', async () => {
    await expect(visibleCodes(PLATFORM)).resolves.toContain('HOME10');
    await expect(visibleCodes(RESELLER_A)).resolves.not.toContain('HOME10');
    await expect(visibleCodes(RESELLER_B)).resolves.not.toContain('HOME10');
  });

  it('with tenant rows, only the tenants named see it — not the platform owner', async () => {
    await expect(visibleCodes(RESELLER_A)).resolves.toContain('ALPHAGIFT');
    await expect(visibleCodes(RESELLER_B)).resolves.not.toContain('ALPHAGIFT');
    await expect(visibleCodes(PLATFORM)).resolves.not.toContain('ALPHAGIFT');
  });

  it('a tenant reads only the coupon_tenant rows naming it', async () => {
    const rows = (tenantId: string) =>
      runWithTenant({ id: tenantId }, () =>
        tenantTransaction(app, (tx: Prisma.TransactionClient) => tx.couponTenant.count()),
      );
    await expect(rows(RESELLER_A)).resolves.toBe(1);
    await expect(rows(RESELLER_B)).resolves.toBe(0);
  });

  it('never lets a tenant write a platform coupon', async () => {
    await expect(
      runWithTenant({ id: RESELLER_A }, () =>
        tenantTransaction(app, (tx: Prisma.TransactionClient) =>
          tx.coupon.update({ where: { id: FOR_A }, data: { label: 'mine now' } }),
        ),
      ),
    ).rejects.toThrow();
  });
});

it('ships the coupon.manage permission', async () => {
  await expect(owner.permission.count({ where: { key: 'coupon.manage' } })).resolves.toBe(1);
});

/**
 * A `free_grant` coupon (F-502-l-a, D-35) gives a Grant of one variant: the
 * database holds that it names exactly that variant and no value, and the
 * top-up engine refuses it as not a discount, as it does a gift code.
 */
describe('a free_grant coupon', () => {
  const CATEGORY = '88888888-8888-4888-8888-8888888888a1';
  const PRODUCT = '88888888-8888-4888-8888-8888888888a2';
  const VARIANT = '88888888-8888-4888-8888-8888888888a3';
  const FREE = '88888888-8888-4888-8888-8888888888a4';

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category (id, key, "nameKey") VALUES ('${CATEGORY}', 'vpn', 'k.v')`);
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product (id, key, "nameKey", "fulfilmentKind") VALUES ('${PRODUCT}', 'vpn_free', 'k.p', 'network_access')
    `);
    await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category_link ("productId", "categoryId", "tenantId") SELECT id, '${CATEGORY}', "tenantId" FROM catalog.product WHERE id = '${PRODUCT}'`);
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product_variant (id, "productId", sku, "billingMode", visibility) VALUES ('${VARIANT}', '${PRODUCT}', 'FREE-30', 'prepaid', 'public')
    `);
  });

  const insert = (id: string, code: string, type: string, value: string, variant: string | null) =>
    owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "createdByAdminId", "grantVariantId", "currencyCode")
      VALUES ('${id}', '${RESELLER_A}', '${code}', '${type}', ${value}, '${ADMIN}', ${variant ? `'${variant}'` : 'NULL'}, 'USD')
    `);

  it('names exactly one variant, only for that type, and carries no value', async () => {
    await expect(insert('88888888-8888-4888-8888-8888888888b1', 'FREENOVARIANT', 'free_grant', '0', null)).rejects.toThrow(/coupon_free_grant_names_variant/);
    await expect(insert('88888888-8888-4888-8888-8888888888b2', 'FREEWITHVALUE', 'free_grant', '5.00', VARIANT)).rejects.toThrow(/coupon_free_grant_has_no_value/);
    await expect(insert('88888888-8888-4888-8888-8888888888b3', 'PERCENTVARIANT', 'percentage', '10.00', VARIANT)).rejects.toThrow(/coupon_free_grant_names_variant/);
    await expect(insert(FREE, 'FREEVPN', 'free_grant', '0', VARIANT)).resolves.toBe(1);
  });

  it('is refused at the top-up as not a discount', async () => {
    const rows = await runWithTenant({ id: RESELLER_A }, () =>
      tenantTransaction(app, (tx: Prisma.TransactionClient) =>
        tx.$queryRawUnsafe<{ outcome: string }[]>(
          `SELECT billing.reserve_coupon('${FREE}'::uuid, '${ADMIN}'::uuid, gen_random_uuid(), NULL, 1.00) AS outcome`,
        ),
      ),
    );
    expect(rows[0].outcome).toBe('not_a_discount');
  });
});
