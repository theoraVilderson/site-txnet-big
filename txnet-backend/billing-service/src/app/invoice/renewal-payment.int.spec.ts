/**
 * Paying a renewal invoice (F-305-d, billing contract.renewal.md rules 11–14,
 * ADR-0158), against a real Postgres built from the committed migration history.
 *
 * What only a database can say:
 *
 *   - Concurrent pays renew the Grant **exactly once**: one debit, one
 *     `grant_renewal` row naming the invoice as its request, one raise, one
 *     live event — and no Grant issued, no sales unit counted.
 *   - The bag and days added are the ones quoted on the invoice.
 *   - A switch to another plan of the product writes the Grant's new variant,
 *     bag and period, so its next renewal is of that plan.
 *   - It is one transaction: a Grant that can no longer be renewed (cancelled
 *     since the invoice) takes the debit and the flip with it.
 *
 *   npm run test:int
 */
import { GrantSource, GrantStatus, InvoiceStatus, Prisma, PrismaClient, WalletReasonType } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import { HARNESS_TIMEOUT_MS, PostgresFixture, prismaAt, startPostgresFixture } from '../../../../test-support/postgres-fixture';
import { GrantService } from '../entitlement/grant';
import { CouponReservationService } from '../payment/coupon/coupon-reservation';
import { PrismaService } from '../prisma/prisma.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { InvoicePaid, InvoicePaymentService, InvoiceUnpayable } from './invoice-payment.service';
import { RenewalRefused } from './renewal-invoice';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT = '11111111-1111-4111-8111-111111111111';
const PLATFORM = '10000000-0000-4000-8000-000000000001';
const ROLE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333331';
const CATEGORY = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const PLAN_30 = '66666666-6666-4666-8666-666666666661';
const PLAN_90 = '66666666-6666-4666-8666-666666666662';
const PRICE_30 = '77777777-7777-4777-8777-777777777771';
const PRICE_90 = '77777777-7777-4777-8777-777777777772';
const RATE = '78787878-7878-4878-8878-787878787878';

const GIB = BigInt(1024 ** 3);
const DAY_MS = 86_400_000;

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let payments: InvoicePaymentService;
let grants: GrantService;

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

  await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  // The ledger rounds to the currency's places, read from the registry (ADR-0153).
  await owner.$executeRawUnsafe(`INSERT INTO currency.currency (id, code, name, symbol, "decimalPlaces") VALUES (gen_random_uuid(), 'USD', 'USD', '$', 2)`);
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
    VALUES ('${TENANT}', 'reseller', '${TENANT}', 'alpha', 'active', 'pay_as_you_go_metered', now()),
           ('${PLATFORM}', 'platform_owner', '${PLATFORM}', 'home', 'active', 'pay_as_you_go_metered', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
    VALUES ('${USER}', '${TENANT}', 'Someone', 'x', '${ROLE}', now())
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.wallet (id, "ownerUserId", "cachedBalance", version, "currencyCode") VALUES (gen_random_uuid(), '${USER}', 100.00, 0, 'USD')
  `);
  await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category (id, "tenantId", key, "nameKey") VALUES ('${CATEGORY}', '${PLATFORM}', 'vpn', 'k')`);
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind") VALUES ('${PRODUCT}', '${PLATFORM}', 'vpn_basic', 'k', 'network_access')
  `);
  await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category_link ("productId", "categoryId", "tenantId") VALUES ('${PRODUCT}', '${CATEGORY}', '${PLATFORM}')`);
  for (const [variant, price, sku, days, gib, amount] of [
    [PLAN_30, PRICE_30, 'VPN-30', 30, 50, '12.50'],
    [PLAN_90, PRICE_90, 'VPN-90', 90, 200, '30.00'],
  ] as const) {
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, "durationDays", quotas)
      VALUES ('${variant}', '${PLATFORM}', '${PRODUCT}', '${sku}', 'prepaid', 'public', ${days},
              '{"traffic_bytes": {"limit": ${BigInt(gib) * GIB}, "resetPolicy": "none"}}')
    `);
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.price (id, "tenantId", "variantId", amount, "currencyCode", "effectiveFrom") VALUES ('${price}', '${PLATFORM}', '${variant}', ${amount}, 'USD', '2026-01-01')
    `);
  }

  // F-305-e: GiB and days typed are priced by the product's renewal rate.
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.renewal_rate (id, "tenantId", "productId", "pricePerGib", "pricePerDay", "minGib", "maxGib", "minDays", "maxDays", "currencyCode", "effectiveFrom")
    VALUES ('${RATE}', '${PLATFORM}', '${PRODUCT}', 0.1, 0.05, 1, 500, 1, 365, 'USD', '2026-01-01')
  `);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  grants = new GrantService(app);
  payments = new InvoicePaymentService(app, new WalletLedgerService(), grants, new CouponReservationService());
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

/** A Grant on the 30-day plan, as staff would hand it over: active at once. */
const grantOn30 = () =>
  runWithTenant({ id: TENANT }, () =>
    tenantTransaction(app, (tx) => grants.issue(tx, { userId: USER, variantId: PLAN_30, source: GrantSource.admin_grant, startsAt: new Date() })),
  ).then((issued) => issued.grant.id);

let invoices = 0;
/** A renewal invoice as F-305-c writes one: the plan's price, and what it added when quoted. */
async function renewalInvoice(grantId: string, plan: { variantId: string; priceId: string | null; amount: string; gib: number; days: number; renewalRateId?: string }) {
  invoices += 1;
  const id = `bbbbbbbb-bbbb-4bbb-8bbb-${String(invoices).padStart(12, '0')}`;
  await owner.invoice.create({
    data: {
      id,
      tenantId: TENANT,
      userId: USER,
      variantId: plan.variantId,
      priceId: plan.priceId,
      renewalRateId: plan.renewalRateId ?? null,
      amount: new Prisma.Decimal(plan.amount),
      discount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(plan.amount),
      currencyCode: 'USD',
      grantId,
      renewBytes: BigInt(plan.gib) * GIB,
      renewDays: plan.days,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  return id;
}

const SAME_PLAN = { variantId: PLAN_30, priceId: PRICE_30, amount: '12.50', gib: 50, days: 30 };
const pay = (invoiceId: string) => runWithTenant({ id: TENANT }, () => payments.pay({ userId: USER, invoiceId }));
const balance = async () => (await owner.wallet.findUniqueOrThrow({ where: { ownerUserId: USER } })).cachedBalance.toFixed(2);

describe('paying a renewal invoice (F-305-d)', () => {
  it('concurrent pays renew the Grant exactly once, by what was quoted, and issue nothing', async () => {
    const grantId = await grantOn30();
    const before = await owner.grant.findUniqueOrThrow({ where: { id: grantId } });
    const id = await renewalInvoice(grantId, SAME_PLAN);
    const wallet = await balance();

    const results = await Promise.allSettled(Array.from({ length: 4 }, () => pay(id)));
    const won = results.filter((r): r is PromiseFulfilledResult<InvoicePaid> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => (r.reason as InvoiceUnpayable).reason)).toEqual(Array(3).fill('already_paid'));
    expect(won[0].value).toMatchObject({ id, status: InvoiceStatus.paid, total: '12.50', grants: [{ id: grantId, status: GrantStatus.active }] });

    const after = await owner.grant.findUniqueOrThrow({ where: { id: grantId } });
    expect(after.purchasedBytes - before.purchasedBytes).toBe(BigInt(50) * GIB);
    expect((after.endsAt?.getTime() ?? 0) - (before.endsAt?.getTime() ?? 0)).toBe(30 * DAY_MS);

    const debits = await owner.walletTransaction.findMany({ where: { referenceId: id } });
    expect(debits.map((d) => [d.reasonType, d.amount.toFixed(2)])).toEqual([[WalletReasonType.product_purchase, '12.50']]);
    expect(Number(wallet) - Number(await balance())).toBe(12.5);

    const renewals = await owner.grantRenewal.findMany({ where: { grantId } });
    expect(renewals.map((r) => [r.requestId, r.actorUserId, r.plan, r.bytes, r.days])).toEqual([[id, USER, true, BigInt(50) * GIB, 30]]);
    // A renewal issues no Grant and is no sale of a unit (ADR-0158 (2)).
    expect(await owner.grant.count({ where: { sourceReferenceId: id } })).toBe(0);
    expect((await owner.invoice.findUniqueOrThrow({ where: { id } })).salesCounted).toBe(false);

    const events = await owner.outboxEvent.findMany({ where: { payload: { path: ['invoiceId'], equals: id } } });
    expect(events.map((e) => [e.type, e.aggregateId])).toEqual([[OutboxEventType.GRANT_RENEWED, grantId]]);
    expect(events[0].payload).toMatchObject({ tenantId: TENANT, userId: USER, grantId });
  });

  it('a switch to another plan of the product makes it the Grant’s plan, bag and period', async () => {
    const grantId = await grantOn30();
    const id = await renewalInvoice(grantId, { variantId: PLAN_90, priceId: PRICE_90, amount: '30.00', gib: 200, days: 90 });

    await pay(id);

    const after = await owner.grant.findUniqueOrThrow({ where: { id: grantId } });
    expect(after.variantId).toBe(PLAN_90);
    expect(after.periodDays).toBe(90);
    expect(after.quotas).toMatchObject({ traffic_bytes: { limit: Number(BigInt(200) * GIB) } });
    expect(after.purchasedBytes).toBe(BigInt(250) * GIB);
  });

  it('GiB and days typed are paid as quoted, on the Grant’s own plan, and recorded as typed (F-305-e)', async () => {
    const grantId = await grantOn30();
    const before = await owner.grant.findUniqueOrThrow({ where: { id: grantId } });
    // 7 × 0.1 + 10 × 0.05 = 1.20, quoted on the rate; the plan's own price is never read.
    const id = await renewalInvoice(grantId, { variantId: PLAN_30, priceId: null, renewalRateId: RATE, amount: '1.20', gib: 7, days: 10 });

    expect(await pay(id)).toMatchObject({ total: '1.20', grants: [{ id: grantId }] });

    const after = await owner.grant.findUniqueOrThrow({ where: { id: grantId } });
    expect(after.purchasedBytes - before.purchasedBytes).toBe(BigInt(7) * GIB);
    expect(after.variantId).toBe(PLAN_30);
    const [renewal] = await owner.grantRenewal.findMany({ where: { requestId: id } });
    expect([renewal.plan, renewal.bytes, renewal.days]).toEqual([false, BigInt(7) * GIB, 10]);
  });

  it('a Grant closed since the invoice is refused, and nothing is written', async () => {
    const grantId = await grantOn30();
    const id = await renewalInvoice(grantId, SAME_PLAN);
    await owner.grant.update({ where: { id: grantId }, data: { status: GrantStatus.cancelled } });
    const wallet = await balance();

    const e = await pay(id).then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(RenewalRefused);
    expect((e as RenewalRefused).reason).toBe('grant_not_renewable');

    expect(await balance()).toBe(wallet);
    expect((await owner.invoice.findUniqueOrThrow({ where: { id } })).status).toBe(InvoiceStatus.pending);
    expect(await owner.grantRenewal.count({ where: { grantId } })).toBe(0);
  });
});
