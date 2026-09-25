/**
 * The loading half of coupon validation (F-092-g), against a real Postgres
 * built from the committed migration history.
 *
 * Two things only a database can say. First, which coupons a tenant sees:
 * `coupon` is not in `TENANT_SCOPED_MODELS`, because the extension would add
 * `tenantId = <mine>` and hide the platform-wide rows. Its RLS policy is the
 * shared-read shape instead (`mine`, or a platform coupon that serves me —
 * ADR-0048, `20260914000900_…`), and it binds
 * only on a connection that set `app.tenant_id` — so the read must run in a
 * `tenantTransaction`, and a code of another tenant must find nothing even
 * though it exists. Second, what counts toward the per-user limit: live
 * redemptions (`pending`, `confirmed`) and not finished ones (billing
 * invariant 6).
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  runWithTenant,
  tenantTransaction,
  TenantContextMissing,
  TenantScopeConflict,
  withTenant,
} from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponRequest, CouponValidationService } from './coupon-validation';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const CATEGORY = '66666666-6666-4666-8666-666666666666';
const PRODUCT = 'abababab-abab-4bab-8bab-abababababab';
const OTHER_VARIANT = '88888888-8888-4888-8888-888888888888';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
const validator = new CouponValidationService();

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

  for (const [id, slug] of [[TENANT_A, 'alpha'], [TENANT_B, 'beta']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product_category (id, key, "nameKey") VALUES ('${CATEGORY}', 'vpn', 'catalog.category.vpn.name')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product (id, key, "nameKey", "fulfilmentKind")
    VALUES ('${PRODUCT}', 'vpn_basic', 'catalog.product.vpn_basic.name', 'network_access')
  `);
  await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category_link ("productId", "categoryId", "tenantId") SELECT id, '${CATEGORY}', "tenantId" FROM catalog.product WHERE id = '${PRODUCT}'`);

  const coupons: Array<[string, string | null, string, number]> = [
    // id suffix, tenant, code, perUserUsageLimit
    ['a1', TENANT_A, 'ALPHA10', 1],
    ['a2', null, 'PLATFORM10', 1],
    ['a3', TENANT_B, 'BETA10', 1],
    ['a4', TENANT_A, 'TWICE10', 2],
    ['a5', TENANT_A, 'VPNONLY10', 1],
  ];
  for (const [suffix, tenantId, code, perUser] of coupons) {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "perUserUsageLimit", "createdByAdminId")
      VALUES ('${couponId(suffix)}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${code}', 'percentage', 10.00, ${perUser}, '${ADMIN}')
    `);
  }
  // PLATFORM10 serves tenant A's users by name (ADR-0048); B is not named.
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon_tenant (id, "couponId", "tenantId") VALUES (gen_random_uuid(), '${couponId('a2')}', '${TENANT_A}')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon_service_scope (id, "couponId", "productId")
    VALUES (gen_random_uuid(), '${couponId('a5')}', '${PRODUCT}')
  `);

  // TWICE10: USER holds one pending and one confirmed; the finished ones do not count.
  let n = 0;
  for (const [userId, status] of [
    [USER, 'pending'],
    [USER, 'confirmed'],
    [USER, 'expired'],
    [USER, 'cancelled'],
    [OTHER_USER, 'expired'],
    [OTHER_USER, 'cancelled'],
    [OTHER_USER, 'confirmed'],
  ]) {
    n += 1;
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.coupon_redemption (id, "couponId", "userId", status, "discountAppliedAmount", "orderReferenceId")
      VALUES (gen_random_uuid(), '${couponId('a4')}', '${userId}', '${status}', 1.00, '${couponId(String(n).padStart(2, '0'))}')
    `);
  }

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

function couponId(suffix: string) {
  return `77777777-7777-4777-8777-7777777777${suffix}`;
}

const topUp = (codes: string[]): CouponRequest => ({
  codes,
  amount: new Prisma.Decimal('20.00'),
  target: { kind: 'wallet_top_up' },
});

const asTenant = <T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  runWithTenant({ id: tenantId }, () => tenantTransaction(app, fn));

it("sees its own and the platform's coupons, never another tenant's", async () => {
  const r = await asTenant(TENANT_A, (tx) =>
    validator.validate(tx, { ...topUp(['alpha10', 'PLATFORM10', 'BETA10']), userId: USER }),
  );

  expect(r.applied.map((a) => [a.code, a.discount.toFixed(2)])).toEqual([
    ['ALPHA10', '2.00'],
    ['PLATFORM10', '1.80'],
  ]);
  expect(r.rejected).toEqual([{ code: 'BETA10', reason: 'not_found' }]);
  // The negative control: the row exists, tenant A's connection cannot see it.
  await expect(owner.coupon.count({ where: { code: 'BETA10' } })).resolves.toBe(1);
});

it('loads the service scope with the coupon', async () => {
  const r = await asTenant(TENANT_A, (tx) =>
    validator.validate(tx, { ...topUp(['VPNONLY10']), userId: USER }),
  );
  expect(r.rejected).toEqual([{ code: 'VPNONLY10', reason: 'out_of_scope' }]);

  const bought = await asTenant(TENANT_A, (tx) =>
    validator.validate(tx, {
      ...topUp(['VPNONLY10']),
      userId: USER,
      target: { kind: 'purchase', productId: PRODUCT, variantId: OTHER_VARIANT },
    }),
  );
  expect(bought.rejected).toEqual([]);
});

it('counts pending and confirmed redemptions toward the per-user limit, and nothing else', async () => {
  const mine = await asTenant(TENANT_A, (tx) =>
    validator.validate(tx, { ...topUp(['TWICE10']), userId: USER }),
  );
  expect(mine.rejected).toEqual([{ code: 'TWICE10', reason: 'per_user_limit_reached' }]);

  // One confirmed plus two finished: one live, under a limit of 2.
  const theirs = await asTenant(TENANT_A, (tx) =>
    validator.validate(tx, { ...topUp(['TWICE10']), userId: OTHER_USER }),
  );
  expect(theirs.rejected).toEqual([]);
});

it('refuses to read outside a tenantTransaction', async () => {
  // Not an empty answer: on an unbound connection RLS would show only the platform rows.
  await expect(
    runWithTenant({ id: TENANT_A }, () =>
      app.$transaction((tx) => validator.validate(tx, { ...topUp(['ALPHA10']), userId: USER })),
    ),
  ).rejects.toBeInstanceOf(TenantScopeConflict);
  await expect(
    app.$transaction((tx) => validator.validate(tx, { ...topUp(['ALPHA10']), userId: USER })),
  ).rejects.toBeInstanceOf(TenantContextMissing);
});

/**
 * A coupon never follows a lent gateway (F-102-f-e). Lending moves a gateway,
 * not the lender's coupons: the borrower's payer is validated in the
 * borrower's tenant, so RLS hides the lender's coupon however well it matches
 * the gateway, and a platform coupon still asks `platform_coupon_serves` about
 * the borrower. Validation never reads a grant — that is the property.
 */
describe('a coupon on a lent gateway', () => {
  const TENANT_GATEWAY = '99999999-9999-4999-8999-999999999991';
  const PLATFORM_GATEWAY = '99999999-9999-4999-8999-999999999992';

  beforeAll(async () => {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.payment_gateway
        (id, "displayName", "providerName", "gatewayCategory", "supportedCurrencies", "merchantId",
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt")
      VALUES ('${PLATFORM_GATEWAY}', 'platform', 'zarinpal', 'domestic_rial', '["IRR"]', 'm', 1.00, 500.00, 'manual', 'percentage', 1.0000, now())
    `);
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant_gateway_config
        (id, "tenantId", "displayName", "providerName", "gatewayCategory",
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt")
      VALUES ('${TENANT_GATEWAY}', '${TENANT_A}', 'alpha gateway', 'zarinpal', 'domestic_rial',
              1.00, 500.00, 'manual', 'percentage', 1.0000, now())
    `);
    // Both gateways are lent to B, actively.
    for (const [gatewayId, configId] of [[PLATFORM_GATEWAY, null], [null, TENANT_GATEWAY]]) {
      await owner.$executeRawUnsafe(`
        INSERT INTO billing.payment_gateway_grant (id, "tenantId", "gatewayId", "tenantGatewayConfigId", "grantedByAdminId")
        VALUES (gen_random_uuid(), '${TENANT_B}', ${gatewayId ? `'${gatewayId}'` : 'NULL'},
                ${configId ? `'${configId}'` : 'NULL'}, '${ADMIN}')
      `);
    }

    const coupons: Array<[string, string | null, string, string, string, string | null]> = [
      // id suffix, tenant, code, coupon_gateway column, the gateway, tenant it names (platform coupons only)
      ['b1', TENANT_A, 'LENT10', '"tenantGatewayConfigId"', TENANT_GATEWAY, null],
      ['b2', null, 'PLATLENT10', '"gatewayId"', PLATFORM_GATEWAY, TENANT_A],
      ['b3', null, 'PLATBETA10', '"gatewayId"', PLATFORM_GATEWAY, TENANT_B],
    ];
    for (const [suffix, tenantId, code, column, gateway, names] of coupons) {
      await owner.$executeRawUnsafe(`
        INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "perUserUsageLimit", "createdByAdminId")
        VALUES ('${couponId(suffix)}', ${tenantId ? `'${tenantId}'` : 'NULL'}, '${code}', 'percentage', 10.00, 1, '${ADMIN}')
      `);
      await owner.$executeRawUnsafe(`
        INSERT INTO billing.coupon_gateway (id, "couponId", ${column}) VALUES (gen_random_uuid(), '${couponId(suffix)}', '${gateway}')
      `);
      if (names) {
        await owner.$executeRawUnsafe(`
          INSERT INTO billing.coupon_tenant (id, "couponId", "tenantId") VALUES (gen_random_uuid(), '${couponId(suffix)}', '${names}')
        `);
      }
    }
  });

  const on = (gatewaySource: 'platform' | 'tenant', gatewayId: string, codes: string[]) => ({
    ...topUp(codes),
    gatewaySource,
    gatewayId,
    userId: USER,
  });

  it("refuses the lender's coupon to the borrower's payer on the lent gateway", async () => {
    const borrower = await asTenant(TENANT_B, (tx) => validator.validate(tx, on('tenant', TENANT_GATEWAY, ['LENT10'])));
    expect(borrower.applied).toEqual([]);
    expect(borrower.rejected).toEqual([{ code: 'LENT10', reason: 'not_found' }]);

    // The control: the same code on the same gateway is good for the lender's own payer.
    const lender = await asTenant(TENANT_A, (tx) => validator.validate(tx, on('tenant', TENANT_GATEWAY, ['LENT10'])));
    expect(lender.applied.map((a) => [a.code, a.discount.toFixed(2)])).toEqual([['LENT10', '2.00']]);
  });

  it('serves a platform coupon on a lent platform gateway to the borrower only if it names the borrower', async () => {
    const borrower = await asTenant(TENANT_B, (tx) =>
      validator.validate(tx, on('platform', PLATFORM_GATEWAY, ['PLATLENT10', 'PLATBETA10'])),
    );
    expect(borrower.applied.map((a) => [a.code, a.discount.toFixed(2)])).toEqual([['PLATBETA10', '2.00']]);
    expect(borrower.rejected).toEqual([{ code: 'PLATLENT10', reason: 'not_found' }]);

    // The control: PLATLENT10 is live on that gateway, for the tenant it names.
    const named = await asTenant(TENANT_A, (tx) =>
      validator.validate(tx, on('platform', PLATFORM_GATEWAY, ['PLATLENT10', 'PLATBETA10'])),
    );
    expect(named.applied.map((a) => a.code)).toEqual(['PLATLENT10']);
    expect(named.rejected).toEqual([{ code: 'PLATBETA10', reason: 'not_found' }]);
  });
});
