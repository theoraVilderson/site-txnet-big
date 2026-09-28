/**
 * Paying an invoice from the wallet (F-111-b, spec §5.8 step 2), against a
 * real Postgres built from the committed migration history.
 *
 * What only a database can say:
 *
 *   - Concurrent pays of one invoice succeed **exactly once** (spec §5.8): one
 *     debit, one Grant, one confirmed coupon use, one outbox row — the rest
 *     wait on the invoice's row lock and find it `paid`.
 *   - It is one transaction: a Grant that cannot be issued (the variant was
 *     switched off after the invoice) takes the debit and the flip with it.
 *   - A balance short of the total writes nothing and says by how much.
 *   - Past its clock, or someone else's, is refused before any lock on money.
 *   - A free invoice moves no money and still issues its Grant.
 *   - A Grant that cannot be delivered is refunded whole, once, and its
 *     invoice cannot be paid again while its clock still runs (F-111-d).
 *
 *   npm run test:int
 */
import { GrantSource, GrantStatus, InvoiceStatus, Prisma, PrismaClient, RedemptionStatus, WalletReasonType } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction, withTenant } from '@txnet-backend/shared-core';

import {
  HARNESS_TIMEOUT_MS,
  PostgresFixture,
  prismaAt,
  startPostgresFixture,
} from '../../../../test-support/postgres-fixture';
import { GrantDeliveryService } from '../entitlement/delivery';
import { EntitlementRefused, GrantService } from '../entitlement/grant';
import { CouponReservationService } from '../payment/coupon/coupon-reservation';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService } from '../traffic/config-actions';
import { WalletCreditService } from '../wallet/wallet-credit.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { InvoicePaid, InvoicePaymentService, InvoiceUnpayable } from './invoice-payment.service';

vi.setConfig({ testTimeout: HARNESS_TIMEOUT_MS, hookTimeout: HARNESS_TIMEOUT_MS });

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROLE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333331';
const POOR_USER = '33333333-3333-4333-8333-333333333332';
const FREE_USER = '33333333-3333-4333-8333-333333333333';
const CATEGORY = '44444444-4444-4444-8444-444444444444';
const PRODUCT = '55555555-5555-4555-8555-555555555555';
const VARIANT = '66666666-6666-4666-8666-666666666661';
const RETIRED_VARIANT = '66666666-6666-4666-8666-666666666662';
const PRICE = '77777777-7777-4777-8777-777777777771';
const RETIRED_PRICE = '77777777-7777-4777-8777-777777777772';
const COUPON = '88888888-8888-4888-8888-888888888888';
const ADMIN = '99999999-9999-4999-8999-999999999999';

let pg: PostgresFixture;
let owner: PrismaClient;
let app: PrismaService;
let payments: InvoicePaymentService;
let delivery: GrantDeliveryService;
const reservations = new CouponReservationService();

beforeAll(async () => {
  pg = await startPostgresFixture();
  owner = prismaAt(pg.ownerUrl);

  await owner.$executeRawUnsafe(`INSERT INTO identity.role (id, name, "isSystemRole") VALUES ('${ROLE}', 'User', true)`);
  await owner.$executeRawUnsafe(`
    INSERT INTO tenant.tenant (id, "tenantType", "ownerUserId", slug, status, "billingModel", "updatedAt")
    VALUES ('${TENANT}', 'reseller', '${TENANT}', 'alpha', 'active', 'pay_as_you_go_metered', now())
  `);
  for (const id of [USER, POOR_USER, FREE_USER]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO identity."user" (id, "tenantId", "fullName", "passwordHash", "roleId", "updatedAt")
      VALUES ('${id}', '${TENANT}', 'Someone', 'x', '${ROLE}', now())
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.wallet (id, "ownerUserId", "cachedBalance", version, "currencyCode") VALUES
      (gen_random_uuid(), '${USER}', 100.00, 0, 'USD'),
      (gen_random_uuid(), '${POOR_USER}', 5.00, 0, 'USD')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product_category (id, key, "nameKey") VALUES ('${CATEGORY}', 'vpn', 'catalog.category.vpn.name')
  `);
  await owner.$executeRawUnsafe(`
    INSERT INTO catalog.product (id, "tenantId", key, "nameKey", "fulfilmentKind")
    VALUES ('${PRODUCT}', NULL, 'vpn_basic', 'k', 'network_access')
  `);
  await owner.$executeRawUnsafe(`INSERT INTO catalog.product_category_link ("productId", "categoryId", "tenantId") SELECT id, '${CATEGORY}', "tenantId" FROM catalog.product WHERE id = '${PRODUCT}'`);
  for (const [variant, price, sku] of [[VARIANT, PRICE, 'VPN-30'], [RETIRED_VARIANT, RETIRED_PRICE, 'VPN-90']]) {
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.product_variant (id, "tenantId", "productId", sku, "billingMode", visibility, "durationDays")
      VALUES ('${variant}', NULL, '${PRODUCT}', '${sku}', 'prepaid', 'public', 30)
    `);
    await owner.$executeRawUnsafe(`
      INSERT INTO catalog.price (id, "variantId", amount, "currencyCode", "effectiveFrom") VALUES ('${price}', '${variant}', 12.50, 'USD', '2026-01-01')
    `);
  }
  await owner.$executeRawUnsafe(`
    INSERT INTO billing.coupon (id, "tenantId", code, "discountType", "discountValue", "totalUsageLimit", "perUserUsageLimit", "createdByAdminId", "currencyCode")
    VALUES ('${COUPON}', '${TENANT}', 'SPRING', 'percentage', 20.00, 10, 0, '${ADMIN}', 'USD')
  `);

  const base = new PrismaService(pg.appUrl);
  app = base.$extends(withTenant(base)) as unknown as PrismaService;
  payments = new InvoicePaymentService(app, new WalletLedgerService(), new GrantService(app), reservations);
  const policy = { get: (k: string) => (k === 'GRANT_DELIVERY_RETRIES' ? 6 : 60_000) };
  delivery = new GrantDeliveryService(
    app,
    {} as never,
    {} as never,
    new ConfigActionsService(),
    new WalletCreditService(new WalletLedgerService()),
    policy as never,
  );
});

afterAll(async () => {
  await Promise.allSettled([app?.$disconnect(), owner?.$disconnect()]);
  await pg?.stop();
});

let invoices = 0;
async function invoice(o: {
  userId?: string;
  variantId?: string;
  priceId?: string;
  amount?: string;
  discount?: string;
  expiresAt?: Date;
} = {}): Promise<string> {
  invoices += 1;
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(invoices).padStart(12, '0')}`;
  const amount = new Prisma.Decimal(o.amount ?? '12.50');
  const discount = new Prisma.Decimal(o.discount ?? '0');
  await owner.invoice.create({
    data: {
      id,
      tenantId: TENANT,
      userId: o.userId ?? USER,
      variantId: o.variantId ?? VARIANT,
      priceId: o.priceId ?? PRICE,
      amount,
      discount,
      total: amount.minus(discount),
      currencyCode: 'USD',
      expiresAt: o.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  return id;
}

const pay = (invoiceId: string, userId = USER) => runWithTenant({ id: TENANT }, () => payments.pay({ userId, invoiceId }));

const balanceOf = async (userId: string) =>
  (await owner.wallet.findUnique({ where: { ownerUserId: userId } }))?.cachedBalance.toFixed(2) ?? null;

const writtenFor = async (invoiceId: string) => ({
  invoice: (await owner.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status,
  debits: await owner.walletTransaction.findMany({ where: { referenceId: invoiceId } }),
  grants: await owner.grant.findMany({ where: { sourceReferenceId: invoiceId } }),
  events: await owner.outboxEvent.findMany({ where: { type: OutboxEventType.GRANT_CREATED, payload: { path: ['invoiceId'], equals: invoiceId } } }),
});

async function refusal(p: Promise<unknown>): Promise<InvoiceUnpayable> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(InvoiceUnpayable);
  return e as InvoiceUnpayable;
}

describe('paying an invoice from the wallet (F-111-b)', () => {
  it('concurrent pays of one invoice succeed exactly once: one debit, one Grant, one coupon use, one event', async () => {
    const id = await invoice({ discount: '2.50' });
    await runWithTenant({ id: TENANT }, () =>
      tenantTransaction(app, (tx) =>
        reservations.reserve(tx, {
          userId: USER,
          orderReferenceId: id,
          applied: [{ couponId: COUPON, code: 'SPRING', discount: new Prisma.Decimal('2.50') }],
        }),
      ),
    );

    const results = await Promise.allSettled(Array.from({ length: 6 }, () => pay(id)));

    const won = results.filter((r): r is PromiseFulfilledResult<InvoicePaid> => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost.map((r) => (r.reason as InvoiceUnpayable).reason)).toEqual(Array(5).fill('already_paid'));

    const [{ value: paid }] = won;
    expect(paid).toMatchObject({ id, status: InvoiceStatus.paid, total: '10.00', balanceAfter: '90.00' });
    expect(paid.grants).toHaveLength(1);
    expect(paid.grants[0].status).toBe(GrantStatus.pending);
    // The link is My services' (F-114-e-c): the pay answers no token.
    expect(paid.grants[0]).not.toHaveProperty('token');

    const written = await writtenFor(id);
    expect(written.invoice).toBe(InvoiceStatus.paid);
    expect(written.debits.map((d) => [d.direction, d.reasonType, d.amount.toFixed(2)])).toEqual([
      ['debit', WalletReasonType.product_purchase, '10.00'],
    ]);
    expect(written.grants.map((g) => [g.source, g.status, g.variantId])).toEqual([[GrantSource.purchase, GrantStatus.pending, VARIANT]]);
    expect(written.events).toHaveLength(1);
    expect(written.events[0]).toMatchObject({ aggregate: 'entitlement.grant', aggregateId: written.grants[0].id });
    expect(await balanceOf(USER)).toBe('90.00');

    const coupon = await owner.coupon.findUniqueOrThrow({ where: { id: COUPON }, select: { usedCount: true, reservedCount: true } });
    expect(coupon).toEqual({ usedCount: 1, reservedCount: 0 });
    const holds = await owner.couponRedemption.findMany({ where: { orderReferenceId: id }, select: { status: true } });
    expect(holds).toEqual([{ status: RedemptionStatus.confirmed }]);
  });

  it('is one transaction: a Grant that cannot be issued takes the debit and the flip with it', async () => {
    const id = await invoice({ variantId: RETIRED_VARIANT, priceId: RETIRED_PRICE });
    await owner.$executeRawUnsafe(`UPDATE catalog.product_variant SET "isActive" = false WHERE id = '${RETIRED_VARIANT}'`);
    const before = await balanceOf(USER);

    await expect(pay(id)).rejects.toBeInstanceOf(EntitlementRefused);

    const written = await writtenFor(id);
    expect(written).toEqual({ invoice: InvoiceStatus.pending, debits: [], grants: [], events: [] });
    expect(await balanceOf(USER)).toBe(before);
  });

  it('a balance short of the total writes nothing and says how much is missing', async () => {
    const id = await invoice({ userId: POOR_USER });

    const e = await refusal(pay(id, POOR_USER));

    expect(e.reason).toBe('insufficient_balance');
    expect(e.shortfall && Object.values(e.shortfall).map((d) => d.toFixed(2))).toEqual(['12.50', '5.00', '7.50']);
    expect(await writtenFor(id)).toEqual({ invoice: InvoiceStatus.pending, debits: [], grants: [], events: [] });
    expect(await balanceOf(POOR_USER)).toBe('5.00');
  });

  it('past its clock — swept or not — is expired, and another user’s is not found', async () => {
    const late = await invoice({ expiresAt: new Date(Date.now() - 1000) });
    expect((await refusal(pay(late))).reason).toBe('expired');
    expect((await writtenFor(late)).debits).toEqual([]);

    const theirs = await invoice();
    expect((await refusal(pay(theirs, POOR_USER))).reason).toBe('not_found');
    expect((await writtenFor(theirs)).invoice).toBe(InvoiceStatus.pending);
  });

  it('a free invoice moves no money and still issues its Grant — to a user with no wallet', async () => {
    const id = await invoice({ userId: FREE_USER, discount: '12.50' });

    const paid = await pay(id, FREE_USER);

    expect(paid).toMatchObject({ status: InvoiceStatus.paid, total: '0.00', balanceAfter: '0.00', walletTransactionId: null });
    const written = await writtenFor(id);
    expect(written.debits).toEqual([]);
    expect(written.grants).toHaveLength(1);
    expect(written.events).toHaveLength(1);
    expect(await balanceOf(FREE_USER)).toBeNull();
  });

  it('an undeliverable Grant is refunded whole, once, and its invoice cannot be paid again (F-111-d)', async () => {
    // The fixture's product is `network_access` with no panel group: nothing can deliver it.
    const id = await invoice();
    const paid = await pay(id);
    expect(await balanceOf(USER)).not.toBeNull();
    const before = new Prisma.Decimal((await balanceOf(USER))!);
    const deliver = () =>
      runWithTenant({ id: TENANT }, () => tenantTransaction(app, (tx) => delivery.deliver(tx, paid.grants[0].id, new Date())));

    await expect(deliver()).resolves.toBe('refunded');
    await expect(deliver()).resolves.toBe('skipped');

    expect(await balanceOf(USER)).toBe(before.plus('12.50').toFixed(2));
    const written = await writtenFor(id);
    expect(written.invoice).toBe(InvoiceStatus.refunded);
    expect(written.debits.map((d) => [d.direction, d.reasonType, d.amount.toFixed(2)])).toEqual(
      expect.arrayContaining([
        ['debit', WalletReasonType.product_purchase, '12.50'],
        ['credit', WalletReasonType.product_refund, '12.50'],
      ]),
    );
    expect(written.debits).toHaveLength(2);
    expect(written.grants.map((g) => [g.status, g.statusReason])).toEqual([[GrantStatus.cancelled, 'no_delivery_route']]);
    const refunded = await owner.outboxEvent.findMany({ where: { type: OutboxEventType.GRANT_REFUNDED, aggregateId: paid.grants[0].id } });
    expect(refunded.map((e) => e.payload)).toEqual([expect.objectContaining({ invoiceId: id, amount: '12.50', reason: 'no_delivery_route' })]);

    // Refunded a minute after paying, the invoice's 30-minute clock still runs.
    expect((await refusal(pay(id))).reason).toBe('already_paid');
    expect(await balanceOf(USER)).toBe(before.plus('12.50').toFixed(2));
  });
});
