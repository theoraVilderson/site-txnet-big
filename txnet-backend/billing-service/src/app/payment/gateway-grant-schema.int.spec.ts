/**
 * The grant and settlement constraints F-096-a puts in Postgres (ADR-0041),
 * against a real database built from the committed migration history.
 *
 * Each of these is a guard no service code can stand in for, which is why it is
 * measured here rather than in a unit spec — and each one is a way the platform
 * could come to owe the wrong tenant the wrong money:
 *
 *   * a grant names **exactly one** gateway, the platform's or one reseller's
 *     (ADR-0041 §2). Prisma cannot express it: a CHECK.
 *   * **one live grant per (tenant, gateway)**, and any number of withdrawn
 *     ones. Granting, withdrawing and granting again is ordinary; two live rows
 *     disagreeing about whether a tenant may use a gateway is not.
 *   * a withdrawal is a **complete** state: withdrawn rows say when and by whom,
 *     live rows say neither. A half-withdrawn grant is one an operator would
 *     read as live and a reader as dead.
 *   * **one accrual per payment** (ADR-0041 §4). F-096-d writes it inside the
 *     crediting transaction, which a retried callback and a reconciliation
 *     sweep both reach (ADR-0028, invariant 7) — a second row is the platform
 *     owing the same money twice.
 *   * the three tables are **tenant-isolated**, on the borrowing tenant. A
 *     reseller that could read another's accruals could read its revenue.
 *
 * Written through the owner role except where isolation is the subject, the
 * same split `payment-schema.int.spec.ts` uses.
 *
 *   npm run test:int
 */
import { PrismaClient } from '@prisma/client';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const OWNER_TENANT = '11111111-1111-4111-8111-111111111111';
const BORROWER = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const USER = '66666666-6666-4666-8666-666666666666';
const PLATFORM_GATEWAY = '77777777-7777-4777-8777-777777777777';
const RESELLER_GATEWAY = '88888888-8888-4888-8888-888888888888';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaClient;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);
  app = prismaAt(pg.appUrl);
  await seed();
});

afterAll(async () => {
  await app?.$disconnect();
  await owner?.$disconnect();
  await pg?.stop();
});

async function seed() {
  await owner.$executeRawUnsafe(`
    INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE_ID}', 'harness_user', false)
  `);
  for (const [id, slug] of [
    [OWNER_TENANT, 'owner'],
    [BORROWER, 'borrower'],
    [OTHER_TENANT, 'other'],
  ]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
      VALUES ('${id}', 'reseller', '${id}', '${slug}', 'active', 'pay_as_you_go_metered', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
    VALUES ('${USER}', '${BORROWER}', 'borrower person', 'x', '${ROLE_ID}', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_gateway
      (id, "displayName", "providerName", "gatewayCategory", "supportedCurrencies", "merchantId",
       "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt", "currencyCode")
    VALUES ('${PLATFORM_GATEWAY}', 'platform', 'zarinpal', 'domestic_rial', '["IRR"]', 'm',
            1.00, 500.00, 'manual', 'percentage', 1.0000, now(), 'USD')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant_gateway_config
      (id, "tenantId", "displayName", "providerName", "gatewayCategory",
       "minAcceptAmount", "maxAcceptAmount", "feeCalculationMode", "feeType", "feeValue", "updatedAt", "currencyCode")
    VALUES ('${RESELLER_GATEWAY}', '${OWNER_TENANT}', 'owner gateway', 'zarinpal', 'domestic_rial',
            1.00, 500.00, 'manual', 'percentage', 1.0000, now(), 'USD')
  `);
}

/** A grant, by its two gateway columns. `null` for either means "leave it out". */
function insertGrant(id: string, tenantId: string, gatewayId: string | null, configId: string | null) {
  return owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_gateway_grant (id, "tenantId", "gatewayId", "tenantGatewayConfigId", "grantedByAdminId")
    VALUES ('${id}', '${tenantId}', ${gatewayId ? `'${gatewayId}'` : 'NULL'},
            ${configId ? `'${configId}'` : 'NULL'}, '${ADMIN}')
  `);
}

function withdraw(id: string, complete: boolean) {
  return owner.$executeRawUnsafe(`
    UPDATE billing.payment_gateway_grant
       SET "isActive" = false,
           "withdrawnAt" = ${complete ? 'now()' : 'NULL'},
           "withdrawnByAdminId" = ${complete ? `'${ADMIN}'` : 'NULL'}
     WHERE id = '${id}'
  `);
}

function insertPayment(id: string, tenantId: string, grantId: string | null) {
  return owner.$executeRawUnsafe(`
    INSERT INTO billing.payment_transaction
      (id, "tenantId", "userId", "gatewayId", "amountRequested", "feeApplied",
       "amountCredited", "chargedAmountMinor", status, "grantId", "currencyCode")
    VALUES ('${id}', '${tenantId}', '${USER}', '${PLATFORM_GATEWAY}', 10.00, 0.00,
            10.00, 100000, 'success', ${grantId ? `'${grantId}'` : 'NULL'}, 'USD')
  `);
}

const uuid = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ADR-0041 §2: a grant names exactly one gateway', () => {
  it('refuses a grant naming no gateway', async () => {
    await expect(insertGrant(uuid(1), BORROWER, null, null)).rejects.toThrow(
      /payment_gateway_grant_one_gateway/,
    );
  });

  it('refuses a grant naming both a platform and a reseller gateway', async () => {
    await expect(insertGrant(uuid(2), BORROWER, PLATFORM_GATEWAY, RESELLER_GATEWAY)).rejects.toThrow(
      /payment_gateway_grant_one_gateway/,
    );
  });

  it('accepts one of each', async () => {
    await insertGrant(uuid(3), BORROWER, PLATFORM_GATEWAY, null);
    await insertGrant(uuid(4), BORROWER, null, RESELLER_GATEWAY);

    const rows = await owner.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) FROM billing.payment_gateway_grant WHERE "tenantId" = '${BORROWER}'`,
    );
    expect(Number(rows[0].count)).toBe(2);
  });
});

describe('one live grant per tenant and gateway, and any number of dead ones', () => {
  it('refuses a second live grant of the same gateway to the same tenant', async () => {
    // A partial unique index reports the columns it is on, not its own name —
    // which is the pair the rule is about.
    await expect(insertGrant(uuid(5), BORROWER, PLATFORM_GATEWAY, null)).rejects.toThrow(
      /Key \("tenantId", "gatewayId"\).*already exists/,
    );
  });

  it('lets the same gateway be granted again once the first is withdrawn', async () => {
    await withdraw(uuid(3), true);

    await expect(insertGrant(uuid(6), BORROWER, PLATFORM_GATEWAY, null)).resolves.toBe(1);
  });

  it('keeps two tenants apart', async () => {
    await expect(insertGrant(uuid(7), OTHER_TENANT, PLATFORM_GATEWAY, null)).resolves.toBe(1);
  });
});

describe('a withdrawal is a complete state', () => {
  it('refuses a grant marked inactive with no withdrawer and no time', async () => {
    await expect(withdraw(uuid(4), false)).rejects.toThrow(
      /payment_gateway_grant_withdrawal_is_complete/,
    );
  });
});

describe('ADR-0041 §4: one accrual per payment', () => {
  const PAYMENT = uuid(100);

  it('accrues what a granted payment collected', async () => {
    await insertPayment(PAYMENT, BORROWER, uuid(6));

    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO billing.gateway_settlement_entry (id, "grantId", "tenantId", "paymentTransactionId", amount, "currencyCode")
        VALUES ('${uuid(101)}', '${uuid(6)}', '${BORROWER}', '${PAYMENT}', 9.80, 'USD')
      `),
    ).resolves.toBe(1);
  });

  it('refuses a second accrual for the same payment', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO billing.gateway_settlement_entry (id, "grantId", "tenantId", "paymentTransactionId", amount, "currencyCode")
        VALUES ('${uuid(102)}', '${uuid(6)}', '${BORROWER}', '${PAYMENT}', 9.80, 'USD')
      `),
    ).rejects.toThrow(/Key \("paymentTransactionId"\).*already exists/);
  });

  it('refuses a negative accrual and a payout of nothing', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO billing.gateway_settlement_entry (id, "grantId", "tenantId", "paymentTransactionId", amount, "currencyCode")
        VALUES ('${uuid(103)}', '${uuid(6)}', '${BORROWER}', '${uuid(104)}', -1.00, 'USD')
      `),
    ).rejects.toThrow();

    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO billing.gateway_settlement_payout (id, "tenantId", amount, "recordedByAdminId", "currencyCode")
        VALUES ('${uuid(105)}', '${BORROWER}', 0.00, '${ADMIN}', 'USD')
      `),
    ).rejects.toThrow(/gateway_settlement_payout_amount_positive/);
  });

  it('records a payout with its proof key and its operator', async () => {
    await expect(
      owner.$executeRawUnsafe(`
        INSERT INTO billing.gateway_settlement_payout
          (id, "tenantId", amount, "recordedByAdminId", method, reference, "proofAttachmentKey", "currencyCode")
        VALUES ('${uuid(106)}', '${BORROWER}', 9.80, '${ADMIN}', 'sheba', 'TRX-1', 'settlement/2026-09/borrower.pdf', 'USD')
      `),
    ).resolves.toBe(1);
  });
});

describe('the three tables are isolated on the borrowing tenant', () => {
  /** The app pool, bound to one tenant the way `tenantTransaction` binds it. */
  async function asTenant<T>(tenantId: string, sql: string): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
      return (await tx.$queryRawUnsafe(sql)) as T;
    });
  }

  it('shows a tenant its own grants and nobody else theirs', async () => {
    const mine = await asTenant<Array<{ count: bigint }>>(
      BORROWER,
      `SELECT count(*) FROM billing.payment_gateway_grant`,
    );
    const theirs = await asTenant<Array<{ count: bigint }>>(
      OTHER_TENANT,
      `SELECT count(*) FROM billing.payment_gateway_grant`,
    );

    expect(Number(mine[0].count)).toBeGreaterThan(0);
    // `OTHER_TENANT` has exactly the one grant it was given above, and none of
    // the borrower's — which is the whole assertion.
    expect(Number(theirs[0].count)).toBe(1);
  });

  it('shows a tenant its own accruals and payouts only', async () => {
    const entries = await asTenant<Array<{ count: bigint }>>(
      OTHER_TENANT,
      `SELECT count(*) FROM billing.gateway_settlement_entry`,
    );
    const payouts = await asTenant<Array<{ count: bigint }>>(
      OTHER_TENANT,
      `SELECT count(*) FROM billing.gateway_settlement_payout`,
    );

    expect(Number(entries[0].count)).toBe(0);
    expect(Number(payouts[0].count)).toBe(0);
  });

  it('refuses to write a row into another tenant', async () => {
    await expect(
      asTenant(
        OTHER_TENANT,
        `INSERT INTO billing.gateway_settlement_payout (id, "tenantId", amount, "recordedByAdminId", "currencyCode")
         VALUES ('${uuid(107)}', '${BORROWER}', 5.00, '${ADMIN}', 'USD')`,
      ),
    ).rejects.toThrow();
  });
});

/**
 * F-102-f-b (ADR-0053 amendment): a tenant admin deletes its own lent gateway
 * on the app pool, where the borrowers' payments and grants are invisible. The
 * two SECURITY DEFINER functions see them for it — for its own gateway only.
 */
describe("releasing a lent gateway: the lender's functions, and nobody else's", () => {
  const OPEN = uuid(200);
  let crossTenant: PrismaClient;

  beforeAll(async () => {
    crossTenant = prismaAt(pg.crossTenantUrl);
    await owner.$executeRawUnsafe(`
      INSERT INTO billing.payment_transaction
        (id, "tenantId", "userId", "tenantGatewayConfigId", "amountRequested", "feeApplied",
         "amountCredited", "chargedAmountMinor", status, "grantId", "currencyCode")
      VALUES ('${OPEN}', '${BORROWER}', '${USER}', '${RESELLER_GATEWAY}', 10.00, 0.00,
              10.00, 100000, 'pending', '${uuid(4)}', 'USD')
    `);
  });
  afterAll(async () => crossTenant?.$disconnect());

  async function asTenant<T>(tenantId: string, sql: string): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
      return (await tx.$queryRawUnsafe(sql)) as T;
    });
  }
  const usage = (source: string, id: string) => `SELECT * FROM billing.gateway_usage('${source}', '${id}'::uuid, 86400)`;
  const release = (source: string, id: string) =>
    `SELECT billing.withdraw_gateway_grants('${source}', '${id}'::uuid, '${ADMIN}'::uuid, '10.0.0.9') AS n`;

  it("answers the lender the borrowers' usage of its gateway: payments, open payments, grants", async () => {
    const [row] = await asTenant<Array<Record<string, number>>>(OWNER_TENANT, usage('tenant', RESELLER_GATEWAY));

    expect(row).toEqual({ payments: 1, open_payments: 1, grants: 1 });
  });

  it('refuses a borrower, and any tenant a platform gateway', async () => {
    await expect(asTenant(BORROWER, usage('tenant', RESELLER_GATEWAY))).rejects.toThrow(/gateway_not_callers/);
    await expect(asTenant(BORROWER, release('tenant', RESELLER_GATEWAY))).rejects.toThrow(/gateway_not_callers/);
    await expect(asTenant(OWNER_TENANT, usage('platform', PLATFORM_GATEWAY))).rejects.toThrow(/gateway_not_callers/);
  });

  it("withdraws the lender's grants and writes the audit row in the borrower's tenant", async () => {
    const [{ n }] = await asTenant<Array<{ n: number }>>(OWNER_TENANT, release('tenant', RESELLER_GATEWAY));
    expect(n).toBe(1);

    const [grant] = await owner.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "isActive", "withdrawnByAdminId", "withdrawnAt" IS NOT NULL AS dated FROM billing.payment_gateway_grant WHERE id = '${uuid(4)}'`,
    );
    expect(grant).toEqual({ isActive: false, withdrawnByAdminId: ADMIN, dated: true });

    const audit = await owner.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "tenantId", action::text, "targetEntityId" FROM audit.admin_audit_log WHERE "targetEntityId" = '${uuid(4)}'`,
    );
    expect(audit).toEqual([{ tenantId: BORROWER, action: 'gateway_grant_withdraw', targetEntityId: uuid(4) }]);
  });

  it('serves the platform owner on the cross-tenant pool, platform gateways included', async () => {
    const [row] = await crossTenant.$queryRawUnsafe<Array<Record<string, number>>>(usage('platform', PLATFORM_GATEWAY));

    expect(row).toEqual({ payments: 1, open_payments: 0, grants: 3 });
  });
});
