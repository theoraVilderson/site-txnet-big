/**
 * Analytics across currency changes, against a real Postgres (F-1001-q,
 * billing/contract.analytics.md principle 6, contract.analytics-tabs.md rule 5).
 *
 * One story, written with the code that runs in production: the platform
 * moves USD -> EUR on day 3 and the reseller USD -> IRR on day 5, each through
 * `convertOperatingCurrency`; a sale, the reseller's wholesale charges and a
 * refund land on either side; then both tenants are rebuilt whole — the pass
 * that used to move every earlier cost into today's money.
 *
 * The ways this goes wrong quietly:
 *
 *  - **a day's cost in the money of the pass.** Day 1's cost read in IRR
 *    beside day 1's USD sales: a USD margin of 100% and an IRR loss;
 *  - **the platform's money in the reseller's margin.** A wholesale charge is
 *    in the platform's currency of its day, and is the reseller's cost in the
 *    reseller's currency of that day;
 *  - **a refund split across two currencies.** The refund of a USD sale paid
 *    back in IRR comes off the USD net, and its cost comes off the USD cost;
 *  - **two currencies added.** Each figure stays in its own.
 *
 *   npm run test:int
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { type FxPair, convertOperatingCurrency, runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import { HARNESS_TIMEOUT_MS, PostgresFixture, prismaAt, startPostgresFixture } from '../../../../test-support/postgres-fixture';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { contextOf } from './analytics-context';
import { marginOf } from './analytics-margin';
import { AnalyticsRollupService } from './analytics-rollup.service';
import { analyticsQuerySchema } from './analytics.schema';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const PLATFORM = '20000000-0000-4000-8000-000000000001';
const RESELLER = '20000000-0000-4000-8000-000000000002';
const ROLE = '20000000-0000-4000-8000-000000000003';
const ADMIN = '20000000-0000-4000-8000-000000000004';
const BUYER = '20000000-0000-4000-8000-000000000005';
const PRODUCT = '20000000-0000-4000-8000-000000000006';
const VARIANT = '20000000-0000-4000-8000-000000000007';
const PRICE = '20000000-0000-4000-8000-000000000008';
const FIRST_SALE = '20000000-0000-4000-8000-000000000009';
const SECOND_SALE = '20000000-0000-4000-8000-00000000000a';
const THIRD_SALE = '20000000-0000-4000-8000-00000000000d';
const EUR = '20000000-0000-4000-8000-00000000000b';
const IRR = '20000000-0000-4000-8000-00000000000c';
const ZONE = 'Asia/Tehran';
const DAY = (n: number) => `2026-09-0${n}`;
/** 11:30 in Tehran on day `n`. */
const AT = (n: number) => `${DAY(n)}T08:00:00Z`;
/** 23:00 in Tehran on day 6. */
const NOW = new Date('2026-09-06T19:30:00Z');

/** One USD is 0.92 EUR and 1,050,000 IRR, on every day of the story. */
const EUR_PER_USD = new Prisma.Decimal('0.92');
const IRR_PER_USD = new Prisma.Decimal('1050000');
const pair = (toCode: string, rate: Prisma.Decimal, snapshotId: string): FxPair => ({
  fromCode: 'USD',
  toCode,
  rate,
  from: null,
  to: { snapshotId, currencyCode: toCode, rate, effectiveAt: new Date('2026-01-01') },
});

let pg: PostgresFixture;
let app: PrismaService;
let owner: PrismaClient;
let cross: PrismaClient;
let rollup: AnalyticsRollupService;

const sql = (q: string) => owner.$executeRawUnsafe(q);

beforeAll(async () => {
  pg = await startPostgresFixture();
  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  owner = prismaAt(pg.ownerUrl);
  cross = prismaAt(pg.crossTenantUrl);
  rollup = new AnalyticsRollupService(app, owner as unknown as CrossTenantPrismaService);
  await story();
  for (const tenantId of [PLATFORM, RESELLER]) await rollup.rebuild(tenantId, NOW);
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect(), cross?.$disconnect()]);
  await pg?.stop();
});

/** A currency change as the route makes it, then dated to the morning of day `n` (before that day's events). */
async function change(tenantId: string, fx: FxPair, n: number) {
  await cross.$transaction((tx) => convertOperatingCurrency(tx, { tenantId, toCode: fx.toCode, pair: fx, actorUserId: ADMIN, actorIp: '127.0.0.1' }));
  await sql(`UPDATE billing.currency_change SET "createdAt" = '${DAY(n)}T03:00:00Z' WHERE "tenantId" = '${tenantId}'`);
}

function purchase(invoice: string, amount: string, currency: string, n: number) {
  return sql(`
    INSERT INTO billing.invoice (id, "tenantId", "userId", "variantId", "priceId", amount, discount, total, "currencyCode", status, "expiresAt", "createdAt")
    VALUES ('${invoice}', '${RESELLER}', '${BUYER}', '${VARIANT}', '${PRICE}', ${amount}, 0, ${amount}, '${currency}', 'paid', '${AT(n)}', '${AT(n)}');
  `).then(() => sql(`
    INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "createdAt")
    VALUES (gen_random_uuid(), '${BUYER}', '${RESELLER}', ${amount}, 'debit', 'product_purchase', '${invoice}', 0, '${currency}', '${AT(n)}')`));
}

/** What the reseller pays the platform for use on day `n`, in the billing wallet's currency then. */
function wholesale(amount: string, currency: string, n: number) {
  return sql(`
    INSERT INTO tenant.tenant_billing_transaction (id, "walletId", amount, direction, "reasonType", "balanceAfter", "currencyCode", "createdAt")
    SELECT gen_random_uuid(), w.id, ${amount}, 'debit', 'metered_usage_charge', 0, '${currency}', '${AT(n)}'
    FROM tenant.tenant_billing_wallet w WHERE w."tenantId" = '${RESELLER}'`);
}

async function story() {
  await sql(`INSERT INTO currency.currency (id, code, name, symbol, "decimalPlaces", "isBaseCurrency") VALUES
    (gen_random_uuid(), 'USD', 'US Dollar', '$', 2, true), ('${EUR}', 'EUR', 'Euro', '€', 2, false), ('${IRR}', 'IRR', 'Iranian Rial', '﷼', 0, false)`);
  await sql(`INSERT INTO currency.currency_exchange_rate (id, "currencyId", rate, source, "effectiveAt") VALUES
    ('${EUR}', '${EUR}', ${EUR_PER_USD}, 'external_api', '2026-01-01'), ('${IRR}', '${IRR}', ${IRR_PER_USD}, 'external_api', '2026-01-01')`);
  await sql(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  await sql(`INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", timezone, "operatingCurrencyCode", "updatedAt") VALUES
    ('${PLATFORM}', 'platform_owner', '${ADMIN}', 'platform', 'active', 'pay_as_you_go_metered', '${ZONE}', 'USD', now()),
    ('${RESELLER}', 'reseller', '${ADMIN}', 'alpha', 'active', 'pay_as_you_go_metered', '${ZONE}', 'USD', now())`);
  await sql(`INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt") VALUES ('${BUYER}', '${RESELLER}', 'Buyer', 'x', '${ROLE}', now())`);
  await sql(`INSERT INTO billing.wallet (id, "ownerUserId", "cachedBalance", version, "currencyCode") VALUES ('${BUYER}', '${BUYER}', 0, 0, 'USD')`);
  await sql(`INSERT INTO tenant.tenant_billing_wallet (id, "tenantId", "cachedBalance", version, "currencyCode") VALUES (gen_random_uuid(), '${RESELLER}', 0, 0, 'USD')`);
  await sql(`INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind") VALUES ('${PRODUCT}', '${RESELLER}', 'vpn', 'k', 'network_access')`);
  await sql(`INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, "durationDays")
    VALUES ('${VARIANT}', '${RESELLER}', '${PRODUCT}', 'VPN-30', 'prepaid', 'public', 30)`);
  await sql(`INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom") VALUES ('${PRICE}', '${RESELLER}', '${VARIANT}', 10.00, 'USD', '2026-01-01')`);
  // The reseller's cost per sale, set in dollars and never set again.
  await sql(`INSERT INTO catalog.variant_cost (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom") VALUES (gen_random_uuid(), '${RESELLER}', '${VARIANT}', 4.00, 'USD', '2026-01-01')`);

  await purchase(FIRST_SALE, '10.00', 'USD', 1);
  await wholesale('2.00', 'USD', 2);
  await change(PLATFORM, pair('EUR', EUR_PER_USD, EUR), 3);
  await wholesale('1.00', 'EUR', 4);
  await change(RESELLER, pair('IRR', IRR_PER_USD, IRR), 5);
  await purchase(SECOND_SALE, '10500000', 'IRR', 5);
  await wholesale('1.00', 'EUR', 6);
  // The same buyer buys again on the day the first sale is refunded: one cell, two sale currencies.
  await purchase(THIRD_SALE, '10500000', 'IRR', 6);
  // The day-1 sale refunded on day 6: credited in rials, recording the dollars it was (contract.currency-change.md rule 5).
  await sql(`
    INSERT INTO billing.wallet_transaction (id, "walletId", "tenantId", amount, direction, "reasonType", "referenceId", "balanceAfter", "currencyCode", "sourceAmount", "sourceCurrencyCode", "createdAt")
    VALUES (gen_random_uuid(), '${BUYER}', '${RESELLER}', 10500000, 'credit', 'product_refund', '${FIRST_SALE}', 0, 'IRR', 10.00, 'USD', '${AT(6)}')`);
}

const marginOver = (from: number, to: number) =>
  runWithTenant({ id: RESELLER }, () =>
    tenantTransaction(app, (tx) => marginOf(contextOf(tx, analyticsQuerySchema.parse({ from: DAY(from), to: DAY(to) }), { operating: 'IRR', hides: false }))),
  );

const costRows = () =>
  owner.$queryRawUnsafe<{ day: string; kind: string; currencyCode: string; saleCurrencyCode: string; saleCost: string }[]>(`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, kind::text, "currencyCode", "saleCurrencyCode", "saleCost"::text AS "saleCost"
    FROM billing.analytics_cost_day WHERE "tenantId" = '${RESELLER}' ORDER BY day, kind, "saleCurrencyCode"`);

describe('a reseller and its platform each change currency mid-story (F-1001-q)', () => {
  it("keeps each day's cost in the money the reseller sold in that day, a wholesale charge in either of the platform's", async () => {
    expect((await costRows()).map((r) => [r.day, r.kind, r.currencyCode, r.saleCurrencyCode, r.saleCost])).toEqual([
      [DAY(1), 'sale', 'USD', 'USD', '4.000000'],
      [DAY(2), 'wholesale', 'USD', 'USD', '2.000000'],
      // The platform is in euros by day 4, the reseller still in dollars: 1 / 0.92.
      [DAY(4), 'wholesale', 'EUR', 'USD', '1.086957'],
      [DAY(5), 'sale', 'USD', 'IRR', '4200000.000000'],
      [DAY(6), 'sale', 'USD', 'IRR', '4200000.000000'],
      // The day-1 sale's refund takes its cost back in dollars, beside a new sale in rials.
      [DAY(6), 'sale', 'USD', 'USD', '-4.000000'],
      [DAY(6), 'wholesale', 'EUR', 'IRR', '1141304.347826'],
    ]);
  });

  it('takes the refund off the dollars it was sold in, and sells in rials beside it', async () => {
    const sales = await owner.analyticsSalesDay.findMany({ where: { tenantId: RESELLER }, orderBy: [{ day: 'asc' }, { currencyCode: 'asc' }] });
    expect(sales.map((r) => [r.day.toISOString().slice(0, 10), r.currencyCode, r.refunds.toFixed(2), r.net.toFixed(2), r.orders])).toEqual([
      [DAY(1), 'USD', '0.00', '10.00', 1],
      [DAY(5), 'IRR', '0.00', '10500000.00', 1],
      [DAY(6), 'IRR', '0.00', '10500000.00', 1],
      [DAY(6), 'USD', '10.00', '-10.00', -1],
    ]);
  });

  it('answers a margin per currency: the refunded dollars at nothing, the rials at their cost, no two added', async () => {
    const m = await marginOver(1, 6);
    const product = m.products.find((p) => p.id === PRODUCT);
    expect(product).toMatchObject({
      net: { IRR: '21000000.00', USD: '0.00' },
      cost: { IRR: '8400000.00', USD: '0.00' },
      marginRate: 0.6,
      loss: false,
    });
    expect(m.users?.[0]).toMatchObject({ id: BUYER, cost: { IRR: '8400000.00', USD: '0.00' }, loss: false });
    // What the reseller paid the platform before its own change stays in dollars; after it, in rials.
    expect(m.costParts.unallocated).toEqual({ IRR: '1141304.35', USD: '3.09' });
    expect(m.totals.net.value).toEqual({ IRR: '21000000.00', USD: '0.00' });
  });

  it('a second rebuild after both changes writes the same rows', async () => {
    const before = await costRows();
    await rollup.rebuild(RESELLER, NOW);
    expect(await costRows()).toEqual(before);
  });
});
