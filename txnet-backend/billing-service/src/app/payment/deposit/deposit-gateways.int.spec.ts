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
  prismaAt,
  startPostgresFixture,
} from '../../../../../test-support/postgres-fixture';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CouponValidationService } from '../coupon/coupon-validation';
import { DepositGatewayNotFound, DepositQuoteService } from './deposit-quote.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const ADMIN = '55555555-5555-4555-8555-555555555555';
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
let crossTenant: CrossTenantPrismaService;
let service: DepositQuoteService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

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
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "staticRate", "updatedAt", "currencyCode")
      VALUES ('${id}', '${tenantId}', '${provider}', '${provider}', 'domestic_rial', '${status}', ${active},
         1.00, 1000.00, 'manual', 'percentage', 1.0000, 1000000, now(), 'USD')
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
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "staticRate", "updatedAt", "currencyCode")
      VALUES ('${id}', 'platform ${provider}', '${provider}', 'domestic_rial', '["IRR"]', ${active}, 'PLAINTEXT-NEVER-READ',
         1.00, 1000.00, 'manual', 'percentage', 2.0000, 1000000, now(), 'USD')
    `);
  }

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  // The second pool, unextended, exactly as the module wires it: a granted
  // gateway belongs to the lender and the borrower's policy hides it (F-096-b).
  crossTenant = new CrossTenantPrismaService(pg.crossTenantUrl);

  // Every provider has a driver here, so what hides a row is the query alone.
  const driver = { name: 'zarinpal', chargeCurrency: 'IRR', chargeDecimals: 0 };
  const registry = { has: () => true, get: () => driver };
  // Every gateway here has a merchant id; that the vault decides this is
  // `gateway-merchant.int.spec.ts`, and the filter itself is the unit spec.
  const merchant = {
    credentialsFor: async () => {
      throw new Error('a manual-fee quote reads no credential');
    },
    // Keyed by the **owning** tenant since F-096-b: a granted gateway's
    // merchant id is in the lender's vault, so a fake that answered the same
    // set for everybody would hide the bug it exists to catch.
    configuredSecrets: async (tenantId: string) =>
      new Map(
        [
        ...({
          [TENANT_A]: [A_ZARINPAL, A_PENDING, A_INACTIVE],
          [TENANT_B]: [B_ZARINPAL],
          [PLATFORM]: [P_OWN],
        }[tenantId] ?? []
        ).map((id) => `gateway:tenant:${id}`),
        ...(tenantId === PLATFORM
          ? [PLATFORM_ZARINPAL, PLATFORM_INACTIVE].map((id) => `gateway:platform:${id}`)
          : []),
        ].map((label) => [label, new Set(['merchantId'] as const)]),
      ),
    requireConfigured: async () => undefined,
  };
  // No FX rate published in this fixture: these cases are about which gateway
  // is selectable, and a `staticRate` prices them (F-092-c).
  const fx = { pair: async () => null };
  service = new DepositQuoteService(
    app,
    crossTenant,
    new CouponValidationService(),
    registry as never,
    merchant as never,
    fx as never,
  );
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), crossTenant?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

/** The platform owner grants a gateway to a tenant (ADR-0041 §1). Owner role: this is an operator's act. */
function grant(id: string, toTenant: string, gatewayId: string | null, configId: string | null) {
  return owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_gateway_grant (id, "tenantId", "gatewayId", "tenantGatewayConfigId", "grantedByAdminId")
    VALUES ('${id}', '${toTenant}', ${gatewayId ? `'${gatewayId}'` : 'NULL'},
            ${configId ? `'${configId}'` : 'NULL'}, '${ADMIN}')
  `);
}

function withdrawGrant(id: string) {
  return owner.$executeRawUnsafe(`
    UPDATE billing.payment_gateway_grant
       SET "isActive" = false, "withdrawnAt" = now(), "withdrawnByAdminId" = '${ADMIN}'
     WHERE id = '${id}'
  `);
}

function setGatewayActive(id: string, active: boolean) {
  return owner.$executeRawUnsafe(
    `UPDATE tenant.tenant_gateway_config SET "isActive" = ${active} WHERE id = '${id}'`,
  );
}

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

/**
 * Test mode (the user's call, 2026-09-14): a gateway cannot be tested while it
 * is off, and switching it on shows it to every user. So a caller who may
 * manage gateways (`canTest`) is also offered the ones that are off or not yet
 * verified — its **own** only, each marked `testing` — and everyone else sees
 * exactly what the cases above say.
 */
describe('test mode — a gateway manager is offered its own switched-off gateways', () => {
  it('lists them to a manager, marked, and to nobody else', async () => {
    const manager = await runWithTenant({ id: TENANT_A }, () => service.listGateways({ canTest: true }));

    expect(new Map(manager.map((g) => [g.id, g.testing]))).toEqual(
      new Map([
        [A_ZARINPAL, false],
        [A_PENDING, true],
        [A_INACTIVE, true],
      ]),
    );
    const user = await runWithTenant({ id: TENANT_A }, () => service.listGateways());
    expect(user.map((g) => [g.id, g.testing])).toEqual([[A_ZARINPAL, false]]);
  });

  it.each([
    ['awaiting its test transaction', A_PENDING],
    ['inactive', A_INACTIVE],
  ])('quotes a gateway that is %s for a manager', async (_label, gatewayId) => {
    await expect(
      runWithTenant({ id: TENANT_A }, () =>
        service.quote({ userId: USER, gatewayId, source: 'tenant', amount: new Prisma.Decimal('20.00'), couponCodes: [], canTest: true }),
      ),
    ).resolves.toMatchObject({ gatewayId, fee: '0.20' });
  });

  it("never reaches another tenant's gateway, even for a manager", async () => {
    await expect(
      runWithTenant({ id: TENANT_A }, () =>
        service.quote({ userId: USER, gatewayId: B_ZARINPAL, source: 'tenant', amount: new Prisma.Decimal('20.00'), couponCodes: [], canTest: true }),
      ),
    ).rejects.toBeInstanceOf(DepositGatewayNotFound);
  });

  it("offers the platform owner's manager the switched-off platform gateway too", async () => {
    const gateways = await runWithTenant({ id: PLATFORM }, () => service.listGateways({ canTest: true }));

    expect(gateways.map((g) => [g.source, g.id, g.testing])).toEqual([
      ['platform', PLATFORM_ZARINPAL, false],
      ['platform', PLATFORM_INACTIVE, true],
      ['tenant', P_OWN, false],
    ]);
  });
});

/**
 * ADR-0041 / F-096-b. A grant is the one way a tenant reaches a gateway it does
 * not own, and only a real database can say so: `tenant_gateway_config` has the
 * strict policy, so the borrower's own connection is shown nothing at all — the
 * read runs on the cross-tenant pool, bounded to the ids the borrower's own
 * grants named.
 *
 * Each case here is a way the boundary could be wrong in a direction nobody
 * would notice: a gateway offered to a tenant that was never granted it, a
 * gateway still offered after the grant was withdrawn or after its owner
 * switched it off, or a granted gateway that lists but cannot be quoted.
 */
describe('a granted gateway (ADR-0041)', () => {
  const GRANT_TENANT = 'eeeeeeee-0000-4000-8000-000000000001';
  const GRANT_PLATFORM = 'eeeeeeee-0000-4000-8000-000000000002';

  afterEach(async () => {
    await owner.$executeRawUnsafe(`DELETE FROM billing.payment_gateway_grant`);
    await setGatewayActive(B_ZARINPAL, true);
  });

  it('offers tenant B\'s gateway to tenant A, after its own and marked with its owner', async () => {
    await grant(GRANT_TENANT, TENANT_A, null, B_ZARINPAL);

    const a = await runWithTenant({ id: TENANT_A }, () => service.listGateways());

    // Its own first, the borrowed one after: a tenant's own gateway is the one
    // it configured and the one it expects to see first.
    expect(a.map((g) => g.id)).toEqual([A_ZARINPAL, B_ZARINPAL]);
  });

  it('quotes the granted gateway on its owner\'s stored pricing', async () => {
    await grant(GRANT_TENANT, TENANT_A, null, B_ZARINPAL);

    await expect(quoteAs(TENANT_A, B_ZARINPAL)).resolves.toMatchObject({
      fee: '0.20',
      payable: '20.20',
    });
  });

  it('offers a platform gateway to a reseller only through a grant', async () => {
    await expect(quoteAs(TENANT_A, PLATFORM_ZARINPAL, 'platform')).rejects.toBeInstanceOf(
      DepositGatewayNotFound,
    );

    await grant(GRANT_PLATFORM, TENANT_A, PLATFORM_ZARINPAL, null);

    const a = await runWithTenant({ id: TENANT_A }, () => service.listGateways());
    expect(a.map((g) => [g.source, g.id])).toContainEqual(['platform', PLATFORM_ZARINPAL]);
    await expect(quoteAs(TENANT_A, PLATFORM_ZARINPAL, 'platform')).resolves.toMatchObject({
      source: 'platform',
      fee: '0.40',
    });
  });

  it('takes it away again the moment the grant is withdrawn', async () => {
    await grant(GRANT_TENANT, TENANT_A, null, B_ZARINPAL);
    await withdrawGrant(GRANT_TENANT);

    const a = await runWithTenant({ id: TENANT_A }, () => service.listGateways());

    expect(a.map((g) => g.id)).toEqual([A_ZARINPAL]);
    await expect(quoteAs(TENANT_A, B_ZARINPAL)).rejects.toBeInstanceOf(DepositGatewayNotFound);
  });

  it("takes it away when its owner switches it off, with the grant untouched (ADR-0041 §6)", async () => {
    await grant(GRANT_TENANT, TENANT_A, null, B_ZARINPAL);
    await setGatewayActive(B_ZARINPAL, false);

    const a = await runWithTenant({ id: TENANT_A }, () => service.listGateways());
    const b = await runWithTenant({ id: TENANT_B }, () => service.listGateways());

    // Gone for the borrower and for its owner at the same moment, which is the
    // whole of §6 — a grant never keeps a dead gateway alive.
    expect(a.map((g) => g.id)).toEqual([A_ZARINPAL]);
    expect(b).toEqual([]);
  });

  it('grants nothing to a tenant that was not named', async () => {
    await grant(GRANT_TENANT, TENANT_A, null, B_ZARINPAL);

    const b = await runWithTenant({ id: TENANT_B }, () => service.listGateways());

    // Tenant B owns the gateway and sees it; nobody else's grant is visible to
    // it, and it gains nothing from one made to A.
    expect(b.map((g) => g.id)).toEqual([B_ZARINPAL]);
  });
});
