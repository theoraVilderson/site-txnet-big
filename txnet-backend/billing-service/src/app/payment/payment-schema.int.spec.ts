/**
 * The payment and coupon constraints F-092-d puts in Postgres, against a real
 * database built from the committed migration history.
 *
 * Each of these is a guard no service code can stand in for, which is why it
 * is measured here rather than in a unit spec:
 *
 *   * ADR-0028 — a gateway's own tracking code (Zarinpal's `authority`) is
 *     unique per gateway. A duplicate callback on a second replica meets the
 *     index, not an in-process check. A reseller's gateway is a
 *     `tenant_gateway_config` row, not a `payment_gateway` one (ADR-0006), so
 *     the key exists once per gateway column.
 *   * a payment names exactly one gateway — the platform's or a reseller's.
 *     Neither would leave the ADR-0028 key with nothing to be unique within;
 *     both would make the key ambiguous. Prisma cannot express it: a CHECK.
 *   * D-21 — a user may redeem one coupon more than once, so the old
 *     `@@unique([couponId, userId])` is gone and the per-user limit is counted
 *     in the redemption transaction instead (F-092-h).
 *   * D-20 — a reseller may run several gateways, one per provider.
 *   * D-32 — what a gateway reports actually arrived is a receipt, not money of
 *     record: the amount and its currency are set together or not at all, and
 *     the D-32 providers are enum members a gateway row may name (F-104-a).
 *
 * Written through the owner role on purpose: these are constraints, and RLS
 * already covers both tables (`20260909001500_row_level_security_all_tables`).
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const PLATFORM_GATEWAY = '55555555-5555-4555-8555-555555555555';
const PLATFORM_GATEWAY_2 = '55555555-5555-4555-8555-555555555556';
const RESELLER_GATEWAY = '66666666-6666-4666-8666-666666666666';
const COUPON = '77777777-7777-4777-8777-777777777777';

let pg: PostgresFixture;
let owner: PrismaClient;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  await seed();
});

afterAll(async () => {
  await owner?.$disconnect();
  await pg?.stop();
});

async function seed() {
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE_ID}', 'harness_user', false)
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
    VALUES ('${TENANT}', 'reseller', '${TENANT}', 'alpha', 'active', 'pay_as_you_go_metered', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
    VALUES ('${USER}', '${TENANT}', 'alpha person', 'x', '${ROLE_ID}', now())
  `);
  for (const [id, provider] of [[PLATFORM_GATEWAY, 'zarinpal'], [PLATFORM_GATEWAY_2, 'idpay']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.payment_gateway
        (id, "displayName", "providerName", "gatewayCategory", "supportedCurrencies", "merchantId",
         "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt")
      VALUES ('${id}', 'platform', '${provider}', 'domestic_rial', '["IRR"]', 'm',
              1.00, 500.00, 'manual', 'percentage', 1.0000, now())
    `);
  }
  await insertResellerGateway(RESELLER_GATEWAY, 'zarinpal');
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "perUserUsageLimit", "createdByAdminId")
    VALUES ('${COUPON}', '${TENANT}', 'GIFT10', 'wallet_credit', 10.00, 3, '${USER}')
  `);
}

function insertResellerGateway(id: string, provider: string) {
  return owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant_gateway_config
      (id, "tenantId", "displayName", "providerName", "gatewayCategory",
       "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt")
    VALUES ('${id}', '${TENANT}', 'reseller', '${provider}', 'domestic_rial',
            1.00, 500.00, 'manual', 'fixed', 0.5000, now())
  `);
}

let paymentSeq = 0;

function insertPayment(gateway: {
  gatewayId?: string;
  tenantGatewayConfigId?: string;
  authority?: string;
  rateSnapshotId?: string;
  received?: { minor: string; currency: string | null } | { minor: null; currency: string };
}) {
  paymentSeq += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(paymentSeq).padStart(12, '0')}`;
  const uuidOrNull = (v?: string) => (v ? `'${v}'` : 'NULL');
  return owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_transaction
      (id, "tenantId", "userId", "gatewayId", "tenantGatewayConfigId", "gatewayTrackingCode",
       "amountRequested", "feeApplied", "discountApplied", "amountCredited",
       "chargedAmountMinor", "exchangeRateSnapshot", "exchangeRateSnapshotId",
       "amountReceivedMinor", "receivedCurrency")
    VALUES ('${id}', '${TENANT}', '${USER}', ${uuidOrNull(gateway.gatewayId)},
            ${uuidOrNull(gateway.tenantGatewayConfigId)}, ${gateway.authority ? `'${gateway.authority}'` : 'NULL'},
            10.00, 0.20, 0.00, 10.00, 10404000, 1020000.00000000,
            ${uuidOrNull(gateway.rateSnapshotId)},
            ${gateway.received?.minor ?? 'NULL'}, ${gateway.received?.currency ? `'${gateway.received.currency}'` : 'NULL'})
  `);
}

/** The Postgres SQLSTATE a raw statement failed with, or `null` if it succeeded. */
async function sqlstate(statement: Promise<unknown>): Promise<string | null> {
  try {
    await statement;
    return null;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return String((error.meta as { code?: string } | undefined)?.code ?? error.code);
    }
    throw error;
  }
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

describe('ADR-0028: a gateway tracking code is unique per gateway', () => {
  it('refuses a second payment with the same authority on the same platform gateway', async () => {
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'A0001' }))).toBeNull();
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'A0001' }))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it('refuses a second payment with the same authority on the same reseller gateway', async () => {
    expect(
      await sqlstate(insertPayment({ tenantGatewayConfigId: RESELLER_GATEWAY, authority: 'R0001' })),
    ).toBeNull();
    expect(
      await sqlstate(insertPayment({ tenantGatewayConfigId: RESELLER_GATEWAY, authority: 'R0001' })),
    ).toBe(UNIQUE_VIOLATION);
  });

  it('keeps the same authority apart on different gateways, and lets a pending payment carry none yet', async () => {
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY_2, authority: 'A0001' }))).toBeNull();
    expect(
      await sqlstate(insertPayment({ tenantGatewayConfigId: RESELLER_GATEWAY, authority: 'A0001' })),
    ).toBeNull();
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY }))).toBeNull();
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY }))).toBeNull();
  });
});

describe('a payment names exactly one gateway', () => {
  it('refuses a payment naming no gateway', async () => {
    expect(await sqlstate(insertPayment({ authority: 'N0001' }))).toBe(CHECK_VIOLATION);
  });

  it('refuses a payment naming both a platform and a reseller gateway', async () => {
    expect(
      await sqlstate(
        insertPayment({
          gatewayId: PLATFORM_GATEWAY,
          tenantGatewayConfigId: RESELLER_GATEWAY,
          authority: 'B0001',
        }),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});

describe('F-0606-b: the rate snapshot a payment was priced at', () => {
  it('refuses an id no currency_exchange_rate row answers', async () => {
    // The column exists to be evidence; an id pointing at nothing is not
    // evidence, so the FK is the enforcement and not a convention (ADR-0019).
    expect(
      await sqlstate(
        insertPayment({
          gatewayId: PLATFORM_GATEWAY,
          authority: 'S0001',
          rateSnapshotId: 'ffffffff-0000-4000-8000-000000000000',
        }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('accepts a payment that names no snapshot — a staticRate gateway, and every row before F-092-c', async () => {
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'S0002' }))).toBeNull();
  });
});

describe('D-21: coupons', () => {
  it('lets one user hold two redemptions of one coupon', async () => {
    const redeem = (id: string) =>
      owner.$executeRawUnsafe(`
        INSERT INTO billing.coupon_redemption (id, "couponId", "userId", "discountAppliedAmount", "orderReferenceId")
        VALUES ('${id}', '${COUPON}', '${USER}', 10.00, '${id}')
      `);

    expect(await sqlstate(redeem('bbbbbbbb-0000-4000-8000-000000000001'))).toBeNull();
    expect(await sqlstate(redeem('bbbbbbbb-0000-4000-8000-000000000002'))).toBeNull();
  });
});

describe('D-20: a reseller runs several gateways, one per provider', () => {
  it('accepts a second provider and refuses a second row for the same one', async () => {
    expect(
      await sqlstate(insertResellerGateway('66666666-6666-4666-8666-666666666667', 'idpay')),
    ).toBeNull();
    expect(
      await sqlstate(insertResellerGateway('66666666-6666-4666-8666-666666666668', 'zarinpal')),
    ).toBe(UNIQUE_VIOLATION);
  });
});

describe('D-32: what actually arrived, beside what was asked (F-104-a)', () => {
  it('accepts a payment with no receipt yet, and one whose amount and currency arrived together', async () => {
    expect(await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'R2001' }))).toBeNull();
    expect(
      await sqlstate(
        insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'R2002', received: { minor: '9500000', currency: 'USDTTRC20' } }),
      ),
    ).toBeNull();
  });

  it('refuses an amount without its currency, and a currency without its amount', async () => {
    expect(
      await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'R2003', received: { minor: '100', currency: null } })),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'R2004', received: { minor: null, currency: 'XTR' } })),
    ).toBe(CHECK_VIOLATION);
  });

  it('refuses a negative amount and a currency that is not an upper-case code', async () => {
    expect(
      await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'R2005', received: { minor: '-1', currency: 'USD' } })),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(insertPayment({ gatewayId: PLATFORM_GATEWAY, authority: 'R2006', received: { minor: '1', currency: 'usd' } })),
    ).toBe(CHECK_VIOLATION);
  });

  it('lets a reseller gateway name each D-32 provider, and the in_chat category', async () => {
    const providers = ['oxapay', 'airwallex', 'telegram_stars', 'bale'];
    for (const [i, provider] of providers.entries()) {
      const id = `66666666-6666-4666-8666-00000000010${i}`;
      const category = provider === 'telegram_stars' || provider === 'bale' ? 'in_chat' : 'crypto';
      expect(
        await sqlstate(
          owner.$executeRawUnsafe(`
            INSERT INTO tenant.tenant_gateway_config
              (id, "tenantId", "displayName", "providerName", "gatewayCategory",
               "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt")
            VALUES ('${id}', '${TENANT}', '${provider}', '${provider}', '${category}',
                    1.00, 500.00, 'manual', 'fixed', 0.5000, now())
          `),
        ),
      ).toBeNull();
    }
  });
});
