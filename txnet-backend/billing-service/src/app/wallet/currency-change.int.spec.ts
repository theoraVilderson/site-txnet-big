/**
 * A tenant's currency change against a real Postgres (F-116-f, ADR-0098 part 5).
 *
 * The change is set-based SQL on the cross-tenant pool, under the triggers
 * and CHECKs the migrations hold — a wallet row in its wallet's currency, a
 * price never updated, both-or-neither source columns. A fake store would
 * model those from the same understanding that wrote the SQL, so this runs on
 * a database built from the committed migration history, as
 * `txnet_cross_tenant_user`, the role tenant-service's second pool uses.
 *
 * What it turns on:
 * - live money is converted at one rate: wallet balances (a closing and an
 *   opening row), current and scheduled prices (new rows), a live Grant's
 *   locked rate, coupon / rule / preset / gateway amounts; a static rate is
 *   re-expressed per unit of the new currency;
 * - history is not: earlier ledger rows, earlier price rows, a paid invoice;
 * - a pending invoice is cancelled and its coupon holds given back;
 * - money priced before the change and credited after it lands in the
 *   wallet's currency at the change's rate, recording what it was; a debit
 *   in the old currency is still refused;
 * - a second run to the same currency writes nothing;
 * - the platform's change converts every reseller's billing wallet and the
 *   packages it sells them.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import {
  LedgerCurrencyMismatch,
  TenantBillingLedger,
  WalletLedgerService,
  convertOperatingCurrency,
  type FxPair,
} from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '10000000-0000-4000-8000-000000000001';
const TENANT = '10000000-0000-4000-8000-000000000002';
const ROLE = '10000000-0000-4000-8000-000000000003';
const RICH = '10000000-0000-4000-8000-000000000004';
const EMPTY = '10000000-0000-4000-8000-000000000005';
const ADMIN = '10000000-0000-4000-8000-000000000006';
const PRODUCT = '10000000-0000-4000-8000-000000000007';
const VARIANT = '10000000-0000-4000-8000-000000000008';
const PRICE_NOW = '10000000-0000-4000-8000-000000000009';
const PRICE_LATER = '10000000-0000-4000-8000-00000000000a';
const FIXED_COUPON = '10000000-0000-4000-8000-00000000000b';
const PERCENT_COUPON = '10000000-0000-4000-8000-00000000000c';
const PENDING_INVOICE = '10000000-0000-4000-8000-00000000000d';
const PAID_INVOICE = '10000000-0000-4000-8000-00000000000e';
const GRANT = '10000000-0000-4000-8000-00000000000f';
const EUR_RATE = '10000000-0000-4000-8000-000000000010';
const PLATFORM_PRODUCT = '10000000-0000-4000-8000-000000000011';
const PLATFORM_VARIANT = '10000000-0000-4000-8000-000000000012';
const PLATFORM_PRICE = '10000000-0000-4000-8000-000000000013';
const ROUND_TRIP = '10000000-0000-4000-8000-000000000014';
const ROUND_TRIP_USER = '10000000-0000-4000-8000-000000000015';
const IRR_RATE = '10000000-0000-4000-8000-000000000016';

/** One USD is 0.92 EUR: the pair the change crosses at. */
const usdToEur = (): FxPair => ({
  fromCode: 'USD',
  toCode: 'EUR',
  rate: new Prisma.Decimal('0.92'),
  from: null,
  to: { snapshotId: EUR_RATE, currencyCode: 'EUR', rate: new Prisma.Decimal('0.92'), effectiveAt: new Date() },
});

/** One USD is 1,050,000 IRR, and back: an inverse pair six orders of magnitude apart. */
const IRR_PER_USD = new Prisma.Decimal('1050000');
const usdToIrr = (): FxPair => ({
  fromCode: 'USD',
  toCode: 'IRR',
  rate: IRR_PER_USD,
  from: null,
  to: { snapshotId: IRR_RATE, currencyCode: 'IRR', rate: IRR_PER_USD, effectiveAt: new Date() },
});
const irrToUsd = (): FxPair => ({
  fromCode: 'IRR',
  toCode: 'USD',
  rate: new Prisma.Decimal(1).div(IRR_PER_USD),
  from: { snapshotId: IRR_RATE, currencyCode: 'IRR', rate: IRR_PER_USD, effectiveAt: new Date() },
  to: null,
});

let pg: PostgresFixture;
/** tenant-service's second pool: `txnet_cross_tenant_user`. */
let cross: PrismaClient;
/** The migration role: the seeder, and reads RLS would hide. */
let owner: PrismaClient;

const sql = (q: string) => owner.$executeRawUnsafe(q);
const one = async <T>(q: string): Promise<T> => ((await owner.$queryRawUnsafe(q)) as T[])[0];

beforeAll(async () => {
  pg = await startPostgresFixture();
  cross = prismaAt(pg.crossTenantUrl);
  owner = prismaAt(pg.ownerUrl);
  await seed();
});

afterAll(async () => {
  await Promise.allSettled([cross?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

async function seed() {
  await sql(`INSERT INTO currency.currency (id, code, name, symbol, "decimalPlaces", "isBaseCurrency") VALUES
    (gen_random_uuid(), 'USD', 'US Dollar', '$', 2, true),
    ('${EUR_RATE}', 'EUR', 'Euro', '€', 2, false),
    ('${IRR_RATE}', 'IRR', 'Iranian Rial', '﷼', 0, false)`);
  await sql(`INSERT INTO currency.currency_exchange_rate (id, "currencyId", rate, source) VALUES
    ('${EUR_RATE}', '${EUR_RATE}', 0.92, 'external_api'), ('${IRR_RATE}', '${IRR_RATE}', 1050000, 'external_api')`);
  await sql(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  await sql(`INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt") VALUES
    ('${PLATFORM}', 'platform_owner', '${ADMIN}', 'platform', 'active', 'pay_as_you_go_metered', now()),
    ('${TENANT}', 'reseller', '${ADMIN}', 'alpha', 'active', 'pay_as_you_go_metered', now()),
    ('${ROUND_TRIP}', 'reseller', '${ADMIN}', 'beta', 'active', 'pay_as_you_go_metered', now())`);
  for (const [id, tenantId] of [[RICH, TENANT], [EMPTY, TENANT], [ROUND_TRIP_USER, ROUND_TRIP]]) {
    await sql(`INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${id}', '${tenantId}', 'Someone', 'x', '${ROLE}', now())`);
  }
  // A wallet with a history row, and one that is empty.
  await sql(`INSERT INTO billing.wallet (id, "ownerUserId", "cachedBalance", version, "currencyCode") VALUES
    (gen_random_uuid(), '${RICH}', 100.00, 1, 'USD'), (gen_random_uuid(), '${EMPTY}', 0, 0, 'USD')`);
  await sql(`INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "balanceAfter", "currencyCode")
    SELECT gen_random_uuid(), id, '${TENANT}', 100.00, 'credit', 'admin_manual_adjust', 100.00, 'USD' FROM billing.wallet WHERE "ownerUserId" = '${RICH}'`);

  // A reseller variant with the price in effect and one scheduled.
  await sql(`INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind") VALUES ('${PRODUCT}', '${TENANT}', 'vpn', 'k', 'network_access')`);
  await sql(`INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, "durationDays")
    VALUES ('${VARIANT}', '${TENANT}', '${PRODUCT}', 'VPN-30', 'prepaid', 'public', 30)`);
  await sql(`INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom") VALUES
    ('${PRICE_NOW}', '${TENANT}', '${VARIANT}', 12.50, 'USD', '2026-01-01'),
    ('${PRICE_LATER}', '${TENANT}', '${VARIANT}', 20.00, 'USD', '2099-01-01')`);
  // Its postpaid card on the VPN meter, in effect, and a superseded one (F-118-d).
  await sql(`INSERT INTO catalog.rate_card (id, "tenantId", "variantId", "meterKey", "unitSize", "unitPrice", "currencyCode", mode, "includedQuantity", "afterIncluded", "effectiveFrom") VALUES
    (gen_random_uuid(), '${TENANT}', '${VARIANT}', 'vpn.traffic', 1073741824, 0.30000000, 'USD', 'postpaid', 0, 'metered', '2025-01-01'),
    (gen_random_uuid(), '${TENANT}', '${VARIANT}', 'vpn.traffic', 1073741824, 0.50000000, 'USD', 'postpaid', 5368709120, 'metered', '2026-01-01')`);

  await sql(`INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "minPurchaseAmount", "totalUsageLimit", "perUserUsageLimit", "createdByAdminId", "currencyCode", "reservedCount") VALUES
    ('${FIXED_COUPON}', '${TENANT}', 'FIVE', 'fixed_amount', 5.00, 10.00, 10, 0, '${ADMIN}', 'USD', 1),
    ('${PERCENT_COUPON}', '${TENANT}', 'TWENTY', 'percentage', 20.00, NULL, 10, 0, '${ADMIN}', 'USD', 0)`);
  await sql(`UPDATE billing.coupon SET "maxDiscountCap" = 3.00 WHERE id = '${PERCENT_COUPON}'`);
  await sql(`INSERT INTO billing.discount_rule (id, "tenantId", name, kind, value, "currencyCode", "startsAt", "createdByAdminId") VALUES
    (gen_random_uuid(), '${TENANT}', 'two off', 'fixed_amount', 2.00, 'USD', now(), '${ADMIN}')`);
  await sql(`INSERT INTO billing.deposit_setting ("tenantId", presets, "currencyCode", "updatedAt") VALUES ('${TENANT}', '{10.00,20.00}', 'USD', now())`);
  await sql(`INSERT INTO tenant.tenant_gateway_config (id, "tenantId", "displayName", "providerName", "gatewayCategory", "minAcceptAmount", "maxAcceptAmount",
      "currencyCode", "feeCalculationMode", "feeType", "feeValue", "useLiveRate", "staticRate", "roundingStep", "depositPresets", "updatedAt")
    VALUES (gen_random_uuid(), '${TENANT}', 'Zarinpal', 'zarinpal', 'domestic_rial', 5.00, 500.00, 'USD', 'manual', 'fixed', 1.0000, false, 600000, 1000, '{10.00}', now())`);

  // A USD gateway charging USD at a static 1 per unit, and an empty wallet.
  await sql(`INSERT INTO tenant.tenant_gateway_config (id, "tenantId", "displayName", "providerName", "gatewayCategory",
      "currencyCode", "feeCalculationMode", "feeType", "feeValue", "useLiveRate", "staticRate", "minRate", "updatedAt")
    VALUES (gen_random_uuid(), '${ROUND_TRIP}', 'Stripe', 'stripe', 'international_card', 'USD', 'manual', 'percentage', 0, false, 1, 0.9, now())`);
  await sql(`INSERT INTO billing.wallet (id, "ownerUserId", "cachedBalance", version, "currencyCode") VALUES (gen_random_uuid(), '${ROUND_TRIP_USER}', 0, 0, 'USD')`);

  // An invoice still on its clock holding a coupon, and one already paid.
  for (const [id, status] of [[PENDING_INVOICE, 'pending'], [PAID_INVOICE, 'paid']]) {
    await sql(`INSERT INTO billing.invoice (id, "tenantId", "userId", "variantId", "priceId", amount, discount, total, "currencyCode", status, "expiresAt")
      VALUES ('${id}', '${TENANT}', '${RICH}', '${VARIANT}', '${PRICE_NOW}', 12.50, 0, 12.50, 'USD', '${status}', now() + interval '30 minutes')`);
  }
  await sql(`INSERT INTO billing.coupon_redemption (id, "couponId", "userId", "discountAppliedAmount", "currencyCode", status, "orderReferenceId")
    VALUES (gen_random_uuid(), '${FIXED_COUPON}', '${RICH}', 5.00, 'USD', 'pending', '${PENDING_INVOICE}')`);

  await sql(`INSERT INTO entitlement."grant" (id, "tenantId", "userId", "variantId", source, status, "startsAt", "billingMode", "subscriptionTokenHash", "meteredRate", "meteredRateCurrencyCode")
    VALUES ('${GRANT}', '${TENANT}', '${RICH}', '${VARIANT}', 'purchase', 'active', now(), 'metered', repeat('a', 64), 0.50000000, 'USD')`);

  // The platform: a price of its own, a package, and the reseller's billing wallet.
  await sql(`INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind") VALUES ('${PLATFORM_PRODUCT}', NULL, 'vpn_p', 'k', 'network_access')`);
  await sql(`INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, "durationDays")
    VALUES ('${PLATFORM_VARIANT}', NULL, '${PLATFORM_PRODUCT}', 'P-30', 'prepaid', 'public', 30)`);
  await sql(`INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom") VALUES ('${PLATFORM_PRICE}', NULL, '${PLATFORM_VARIANT}', 10.00, 'USD', '2026-01-01')`);
  await sql(`INSERT INTO tenant.tenant_feature_package (id, name, "monthlyPrice", "includedFeatureKeys", "currencyCode") VALUES (gen_random_uuid(), 'Starter', 10.00, '[]', 'USD')`);
  await sql(`INSERT INTO tenant.tenant_billing_wallet (id, "tenantId", "cachedBalance", version, "currencyCode") VALUES (gen_random_uuid(), '${TENANT}', 50.00, 0, 'USD')`);
}

const change = (tenantId: string, pair: FxPair) =>
  cross.$transaction((tx) => convertOperatingCurrency(tx, { tenantId, toCode: pair.toCode, pair, actorUserId: ADMIN, actorIp: '127.0.0.1' }));

describe('a reseller changes its operating currency USD -> EUR', () => {
  beforeAll(async () => {
    await change(TENANT, usdToEur());
  });

  it('is the tenant currency now, and the change is recorded and audited', async () => {
    expect(await one(`SELECT "operatingCurrencyCode" AS c FROM tenant.tenant WHERE id = '${TENANT}'`)).toEqual({ c: 'EUR' });
    const row = await one<{ fromCode: string; toCode: string; rate: Prisma.Decimal; toSnapshotId: string }>(
      `SELECT "fromCode", "toCode", rate, "toSnapshotId" FROM billing.currency_change WHERE "tenantId" = '${TENANT}'`,
    );
    expect({ ...row, rate: row.rate.toString() }).toEqual({ fromCode: 'USD', toCode: 'EUR', rate: '0.92', toSnapshotId: EUR_RATE });
    expect(await one(`SELECT count(*)::int AS n FROM audit.admin_audit_log WHERE action = 'tenant_currency_change' AND "targetEntityId" = '${TENANT}'`)).toEqual({ n: 1 });
  });

  it('closes each wallet in the old currency and opens it in the new, leaving history as written', async () => {
    const rows = await owner.$queryRawUnsafe<Array<{ amount: string; direction: string; reasonType: string; balanceAfter: string; currencyCode: string }>>(`
      SELECT t.amount::text, t.direction::text, t."reasonType"::text, t."balanceAfter"::text, t."currencyCode"
        FROM billing.wallet_transaction t JOIN billing.wallet w ON w.id = t."walletId"
       WHERE w."ownerUserId" = '${RICH}' ORDER BY t."createdAt"`);
    expect(rows).toEqual([
      { amount: '100.00', direction: 'credit', reasonType: 'admin_manual_adjust', balanceAfter: '100.00', currencyCode: 'USD' },
      { amount: '100.00', direction: 'debit', reasonType: 'currency_change', balanceAfter: '0.00', currencyCode: 'USD' },
      { amount: '92.00', direction: 'credit', reasonType: 'currency_change', balanceAfter: '92.00', currencyCode: 'EUR' },
    ]);
    expect(await one(`SELECT "cachedBalance"::text AS b, "currencyCode" AS c FROM billing.wallet WHERE "ownerUserId" = '${RICH}'`)).toEqual({ b: '92.00', c: 'EUR' });
    // An empty wallet changes its label and writes nothing.
    expect(await one(`SELECT "cachedBalance"::text AS b, "currencyCode" AS c, (SELECT count(*)::int FROM billing.wallet_transaction t WHERE t."walletId" = w.id) AS n
      FROM billing.wallet w WHERE "ownerUserId" = '${EMPTY}'`)).toEqual({ b: '0.00', c: 'EUR', n: 0 });
  });

  it('prices the variant with new rows — now and at its scheduled date — and keeps the old rows', async () => {
    const prices = await owner.$queryRawUnsafe<Array<{ amount: string; currencyCode: string; later: boolean }>>(`
      SELECT amount::text, "currencyCode", "effectiveFrom" > now() AS later FROM catalog.price WHERE "variantId" = '${VARIANT}' ORDER BY "currencyCode", "effectiveFrom"`);
    expect(prices).toEqual([
      { amount: '11.50', currencyCode: 'EUR', later: false },
      { amount: '18.40', currencyCode: 'EUR', later: true },
      { amount: '12.50', currencyCode: 'USD', later: false },
      { amount: '20.00', currencyCode: 'USD', later: true },
    ]);
  });

  it('reprices the rate card in effect as a new card, everything but its price and currency kept', async () => {
    const cards = await owner.$queryRawUnsafe<Array<{ unitPrice: string; currencyCode: string; mode: string; included: string }>>(`
      SELECT "unitPrice"::text, "currencyCode", mode::text, "includedQuantity"::text AS included FROM catalog.rate_card
       WHERE "variantId" = '${VARIANT}' ORDER BY "currencyCode", "effectiveFrom"`);
    expect(cards).toEqual([
      { unitPrice: '0.46000000', currencyCode: 'EUR', mode: 'postpaid', included: '5368709120' },
      { unitPrice: '0.30000000', currencyCode: 'USD', mode: 'postpaid', included: '0' },
      { unitPrice: '0.50000000', currencyCode: 'USD', mode: 'postpaid', included: '5368709120' },
    ]);
  });

  it('converts the amounts in settings, not the percentages', async () => {
    expect(await one(`SELECT "discountValue"::text AS v, "minPurchaseAmount"::text AS min, "currencyCode" AS c FROM billing.coupon WHERE id = '${FIXED_COUPON}'`))
      .toEqual({ v: '4.60', min: '9.20', c: 'EUR' });
    expect(await one(`SELECT "discountValue"::text AS v, "maxDiscountCap"::text AS cap, "currencyCode" AS c FROM billing.coupon WHERE id = '${PERCENT_COUPON}'`))
      .toEqual({ v: '20.00', cap: '2.76', c: 'EUR' });
    expect(await one(`SELECT value::text AS v, "currencyCode" AS c FROM billing.discount_rule WHERE "tenantId" = '${TENANT}'`)).toEqual({ v: '1.84', c: 'EUR' });
    expect(await one(`SELECT presets::text AS p, "currencyCode" AS c FROM billing.deposit_setting WHERE "tenantId" = '${TENANT}'`)).toEqual({ p: '{9.20,18.40}', c: 'EUR' });
    expect(await one(`SELECT "minAcceptAmount"::text AS min, "maxAcceptAmount"::text AS max, "feeValue"::text AS fee, "depositPresets"::text AS p,
        "staticRate"::text AS rate, "roundingStep"::text AS step, "currencyCode" AS c FROM tenant.tenant_gateway_config WHERE "tenantId" = '${TENANT}'`))
      // A static rate is charge units per unit of the tenant's currency, so it divides; its rounding step is in charge units and stays.
      .toEqual({ min: '4.60', max: '460.00', fee: '0.9200', p: '{9.20}', rate: '652173.913043478260869565', step: '1000.00000000', c: 'EUR' });
    expect(await one(`SELECT "meteredRate"::text AS r, "meteredRateCurrencyCode" AS c FROM entitlement."grant" WHERE id = '${GRANT}'`)).toEqual({ r: '0.46000000', c: 'EUR' });
  });

  it('cancels an invoice still on its clock and gives its coupon hold back; a paid one is history', async () => {
    expect(await one(`SELECT status::text AS s, "currencyCode" AS c FROM billing.invoice WHERE id = '${PENDING_INVOICE}'`)).toEqual({ s: 'cancelled', c: 'USD' });
    expect(await one(`SELECT status::text AS s FROM billing.invoice WHERE id = '${PAID_INVOICE}'`)).toEqual({ s: 'paid' });
    expect(await one(`SELECT status::text AS s FROM billing.coupon_redemption WHERE "orderReferenceId" = '${PENDING_INVOICE}'`)).toEqual({ s: 'cancelled' });
    expect(await one(`SELECT "reservedCount" AS n FROM billing.coupon WHERE id = '${FIXED_COUPON}'`)).toEqual({ n: 0 });
  });

  it('credits money priced before the change at its rate, and still refuses a debit in the old currency', async () => {
    const ledger = new WalletLedgerService();
    const moved = await cross.$transaction((tx) =>
      ledger.credit(tx, { userId: RICH, amount: new Prisma.Decimal('10.00'), currencyCode: 'USD', reasonType: 'payment_gateway', tenantId: TENANT }),
    );
    expect([moved.amount.toFixed(2), moved.currencyCode, moved.sourceAmount?.toFixed(2), moved.sourceCurrencyCode, moved.balanceAfter.toFixed(2)])
      .toEqual(['9.20', 'EUR', '10.00', 'USD', '101.20']);

    await expect(cross.$transaction((tx) =>
      ledger.debit(tx, { userId: RICH, amount: new Prisma.Decimal('1.00'), currencyCode: 'USD', reasonType: 'product_purchase', tenantId: TENANT }),
    )).rejects.toBeInstanceOf(LedgerCurrencyMismatch);
  });

  it('writes nothing when run again to the currency it already has', async () => {
    const count = () => one<{ n: number }>(`SELECT (SELECT count(*) FROM billing.wallet_transaction)::int + (SELECT count(*) FROM catalog.price)::int
      + (SELECT count(*) FROM billing.currency_change)::int AS n`);
    const before = await count();
    const outcome = await change(TENANT, usdToEur());
    expect(outcome.changeId).toBeNull();
    expect(await count()).toEqual(before);
  });
});

describe('the platform changes its currency USD -> EUR', () => {
  beforeAll(async () => {
    await change(PLATFORM, usdToEur());
  });

  it('converts every reseller billing wallet, its own prices and the packages it sells', async () => {
    expect(await one(`SELECT "cachedBalance"::text AS b, "currencyCode" AS c FROM tenant.tenant_billing_wallet WHERE "tenantId" = '${TENANT}'`)).toEqual({ b: '46.00', c: 'EUR' });
    const rows = await owner.$queryRawUnsafe<Array<{ amount: string; direction: string; currencyCode: string }>>(`
      SELECT t.amount::text, t.direction::text, t."currencyCode" FROM tenant.tenant_billing_transaction t ORDER BY t."createdAt"`);
    expect(rows).toEqual([
      { amount: '50.00', direction: 'debit', currencyCode: 'USD' },
      { amount: '46.00', direction: 'credit', currencyCode: 'EUR' },
    ]);
    expect(await one(`SELECT "monthlyPrice"::text AS m, "currencyCode" AS c FROM tenant.tenant_feature_package`)).toEqual({ m: '9.20', c: 'EUR' });
    expect(await one(`SELECT amount::text AS a FROM catalog.price WHERE "variantId" = '${PLATFORM_VARIANT}' AND "currencyCode" = 'EUR'`)).toEqual({ a: '9.20' });
  });

  it('credits a billing top-up priced before the change at its rate', async () => {
    const moved = await cross.$transaction((tx) =>
      new TenantBillingLedger().credit(tx, { tenantId: TENANT, amount: new Prisma.Decimal('10.00'), currencyCode: 'USD', reasonType: 'topup_payment' }),
    );
    expect([moved.amount.toFixed(2), moved.currencyCode, moved.sourceAmount?.toFixed(2), moved.balanceAfter.toFixed(2)]).toEqual(['9.20', 'EUR', '10.00', '55.20']);
  });
});

describe('a reseller goes USD -> IRR and back: currencies six orders of magnitude apart', () => {
  const gateway = () => one<{ rate: string; min: string; c: string }>(
    `SELECT "staticRate"::text AS rate, "minRate"::text AS min, "currencyCode" AS c FROM tenant.tenant_gateway_config WHERE "tenantId" = '${ROUND_TRIP}'`);

  it('keeps a static rate divided into one near 1e-6, and brings it back whole', async () => {
    await change(ROUND_TRIP, usdToIrr());
    // 1 / 1,050,000: DECIMAL(18,8) kept 0.00000095, two significant digits (F-116-f).
    expect(await gateway()).toEqual({ rate: '0.000000952380952381', min: '0.000000857142857143', c: 'IRR' });
    await change(ROUND_TRIP, irrToUsd());
    expect(await gateway()).toEqual({ rate: '1.000000000000000000', min: '0.900000000000105000', c: 'USD' });
  });

  it('credits a late refund too small for the new currency one minor unit, never nothing', async () => {
    // 1,000 IRR is 0.00095 USD: rounded, nothing — refused, and its settlement retried forever.
    const moved = await cross.$transaction((tx) => new WalletLedgerService().credit(tx, {
      userId: ROUND_TRIP_USER, amount: new Prisma.Decimal('1000'), currencyCode: 'IRR', reasonType: 'product_refund', tenantId: ROUND_TRIP,
    }));
    expect([moved.amount.toFixed(2), moved.currencyCode, moved.sourceAmount?.toFixed(0), moved.sourceCurrencyCode, moved.balanceAfter.toFixed(2)])
      .toEqual(['0.01', 'USD', '1000', 'IRR', '0.01']);
  });
});
