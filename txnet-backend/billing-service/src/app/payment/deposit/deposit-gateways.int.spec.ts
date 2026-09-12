/**
 * Which gateways a user may pick (F-092-o), against a real Postgres built from
 * the committed migration history, under the app role.
 *
 * Only a database can say it. `tenant.tenant_gateway_config` has the strict RLS
 * policy (`20260909001500_…`), which binds only on a connection that set
 * `app.tenant_id` — a read anywhere else answers nothing and does not fail, so
 * a list that quietly lost its transaction would look like a tenant with no
 * gateways. And a row the user may pick is active **and** verified: a gateway
 * still awaiting its test transaction must not take a user's money.
 *
 * `billing.payment_gateway` has no tenant column and no policy at all, so what
 * keeps a reseller off the platform brand's gateways is the tenant type read
 * here, and nothing in the database (ADR-0006, D-25).
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithTenant, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponValidationService } from '../coupon/coupon-validation';
import { DepositGatewayNotFound, DepositQuoteService } from './deposit-quote.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const A_ZARINPAL = 'aaaaaaaa-0000-4000-8000-000000000001';
const A_PENDING = 'aaaaaaaa-0000-4000-8000-000000000002';
const A_INACTIVE = 'aaaaaaaa-0000-4000-8000-000000000003';
const B_ZARINPAL = 'bbbbbbbb-0000-4000-8000-000000000001';
const P_OWN = 'cccccccc-0000-4000-8000-000000000001';
const PLATFORM_ZARINPAL = 'dddddddd-0000-4000-8000-000000000001';
const PLATFORM_INACTIVE = 'dddddddd-0000-4000-8000-000000000002';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let service: DepositQuoteService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = new PrismaClient({ datasourceUrl: pg.ownerUrl });

  for (const [id, slug, type] of [
    [TENANT_A, 'alpha', 'reseller'],
    [TENANT_B, 'beta', 'reseller'],
    [PLATFORM, 'platform_owner', 'platform_owner'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', '${type}', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }

  const gateways: Array<[string, string, string, string, boolean]> = [
    // id, tenant, provider, verificationStatus, isActive
    [A_ZARINPAL, TENANT_A, 'zarinpal', 'verified', true],
    [A_PENDING, TENANT_A, 'idpay', 'pending_test_transaction', true],
    [A_INACTIVE, TENANT_A, 'nowpayments', 'verified', false],
    [B_ZARINPAL, TENANT_B, 'zarinpal', 'verified', true],
    [P_OWN, PLATFORM, 'zarinpal', 'verified', true],
  ];
  for (const [id, tenantId, provider, status, active] of gateways) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant_gateway_config
        (id, "tenantId", "displayName", "providerName", "gatewayCategory", "verificationStatus", "isActive",
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "staticRate", "updatedAt")
      VALUES ('${id}', '${tenantId}', '${provider}', '${provider}', 'domestic_rial', '${status}', ${active},
         1.00, 1000.00, 'manual', 'percentage', 1.0000, 1000000, now())
    `);
  }

  // The platform brand's own: a 2% fee, so a quote shows which table priced it.
  for (const [id, provider, active] of [
    [PLATFORM_ZARINPAL, 'zarinpal', true],
    [PLATFORM_INACTIVE, 'idpay', false],
  ] as const) {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.payment_gateway
        (id, "displayName", "providerName", "gatewayCategory", "supportedCurrencies", "isActive", "merchantId",
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "staticRate", "updatedAt")
      VALUES ('${id}', 'platform ${provider}', '${provider}', 'domestic_rial', '["IRR"]', ${active}, 'PLAINTEXT-NEVER-READ',
         1.00, 1000.00, 'manual', 'percentage', 2.0000, 1000000, now())
    `);
  }

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;

  // Every provider has a driver here, so what hides a row is the query alone.
  const driver = { name: 'zarinpal', chargeCurrency: 'IRR', chargeDecimals: 0 };
  const registry = { has: () => true, get: () => driver };
  // Every gateway here has a merchant id; that the vault decides this is
  // `gateway-merchant.int.spec.ts`, and the filter itself is the unit spec.
  const merchant = {
    credentialsFor: async () => {
      throw new Error('a manual-fee quote reads no credential');
    },
    configuredLabels: async () =>
      new Set([
        ...[A_ZARINPAL, A_PENDING, A_INACTIVE, B_ZARINPAL, P_OWN].map((id) => `gateway:tenant:${id}`),
        ...[PLATFORM_ZARINPAL, PLATFORM_INACTIVE].map((id) => `gateway:platform:${id}`),
      ]),
    requireConfigured: async () => undefined,
  };
  // No FX rate published in this fixture: these cases are about which gateway
  // is selectable, and a `staticRate` prices them (F-092-c).
  const fx = { current: async () => null };
  service = new DepositQuoteService(
    app,
    new CouponValidationService(),
    registry as never,
    merchant as never,
    fx as never,
  );
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

const quoteAs = (tenantId: string, gatewayId: string, source: 'tenant' | 'platform' = 'tenant') =>
  runWithTenant({ id: tenantId }, () =>
    service.quote({ userId: USER, gatewayId, source, amount: new Prisma.Decimal('20.00'), couponCodes: [] }),
  );

describe('deposit gateways under RLS', () => {
  it("lists only the tenant's own active, verified gateways", async () => {
    const a = await runWithTenant({ id: TENANT_A }, () => service.listGateways());
    const b = await runWithTenant({ id: TENANT_B }, () => service.listGateways());

    expect(a.map((g) => g.id)).toEqual([A_ZARINPAL]);
    expect(b.map((g) => g.id)).toEqual([B_ZARINPAL]);
  });

  it("quotes on the tenant's own gateway from the stored pricing", async () => {
    await expect(quoteAs(TENANT_A, A_ZARINPAL)).resolves.toMatchObject({
      fee: '0.20',
      payable: '20.20',
      charge: { currency: 'IRR', decimals: 0, amountMinor: '20200000' },
    });
  });

  it.each([
    ['another tenant', B_ZARINPAL],
    ['awaiting its test transaction', A_PENDING],
    ['inactive', A_INACTIVE],
  ])('refuses a gateway that is %s', async (_label, gatewayId) => {
    await expect(quoteAs(TENANT_A, gatewayId)).rejects.toBeInstanceOf(DepositGatewayNotFound);
  });

  it("offers the platform owner the platform brand's active gateways beside its own", async () => {
    const gateways = await runWithTenant({ id: PLATFORM }, () => service.listGateways());

    expect(gateways.map((g) => [g.source, g.id])).toEqual([
      ['platform', PLATFORM_ZARINPAL],
      ['tenant', P_OWN],
    ]);
    expect(JSON.stringify(gateways)).not.toContain('PLAINTEXT');
  });

  it('quotes a platform gateway for the platform owner from its own pricing', async () => {
    await expect(quoteAs(PLATFORM, PLATFORM_ZARINPAL, 'platform')).resolves.toMatchObject({
      source: 'platform',
      fee: '0.40',
      payable: '20.40',
    });
  });

  it.each([
    ['a reseller', TENANT_A, PLATFORM_ZARINPAL],
    ['an inactive platform gateway', PLATFORM, PLATFORM_INACTIVE],
    ["a tenant gateway's id named as a platform one", PLATFORM, P_OWN],
  ])('refuses a platform gateway to %s', async (_label, tenantId, gatewayId) => {
    await expect(quoteAs(tenantId, gatewayId, 'platform')).rejects.toBeInstanceOf(DepositGatewayNotFound);
  });
});
