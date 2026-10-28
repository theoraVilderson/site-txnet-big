/**
 * The order of locks in paying an invoice (LIVE-1, 2026-10-28). Thirty buyers
 * paying for one variant at once deadlocked on its row: the Grant's insert
 * takes a KEY SHARE on `catalog.product_variant` through its foreign key, and
 * the sales move after it asks FOR UPDATE on the same row (`move_variant_sales`),
 * so two payers each held what the other waited to upgrade (40P01). The move
 * is taken first, so every payer queues on the row before anything refers to
 * it. What breaks without anyone seeing it: concurrent sales of one product
 * fail at random, never in a test that pays alone.
 *
 * The money, the Grant and the counts are `invoice-payment.int.spec.ts`.
 */
import { GrantStatus, InvoiceStatus, Prisma } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';
import { vi } from 'vitest';

import { InvoicePaymentService } from './invoice-payment.service';

const steps: string[] = [];
vi.mock('@txnet-backend/shared-core', async (original) => ({
  ...(await original<object>()),
  tenantTransaction: async (_prisma: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
}));
vi.mock('../catalog/sales-counts', () => ({ moveSales: async (_tx: unknown, _variantId: string, move: string) => void steps.push(`sales:${move}`) }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const INVOICE = '55555555-5555-4555-8555-555555555555';
const VARIANT = '66666666-6666-4666-8666-666666666666';

const tx = {
  $queryRaw: async (sql: TemplateStringsArray) =>
    sql.join('').includes('billing.invoice')
      ? [{ id: INVOICE, userId: USER, variantId: VARIANT, total: new Prisma.Decimal('1.00'), currencyCode: 'USD', status: InvoiceStatus.pending,
          salesCounted: true, grantId: null, renewBytes: null, renewDays: null, renewalRateId: null, expiresAt: new Date(Date.now() + 60_000) }]
      : [{ cachedBalance: new Prisma.Decimal('5.00'), heldAmount: new Prisma.Decimal('0') }],
  invoice: { update: async () => ({}) },
  outboxEvent: { create: async () => ({ id: 'event' }) },
};
const ledger = { debit: async () => ({ id: 'wallet-tx', balanceAfter: new Prisma.Decimal('4.00') }) };
const grants = {
  issue: async () => {
    steps.push('grant:insert');
    return { token: 'token', grant: { id: 'grant', status: GrantStatus.pending } };
  },
};
const reservations = { confirm: async () => void steps.push('coupons:confirm') };

describe('InvoicePaymentService.pay — the variant row is locked before anything refers to it', () => {
  it('moves the reserved unit to sold before the Grant is inserted', async () => {
    const service = new InvoicePaymentService({} as never, ledger as never, grants as never, reservations as never);

    const paid = await runWithTenant({ id: TENANT }, () => service.pay({ userId: USER, invoiceId: INVOICE }));

    expect(paid.status).toBe(InvoiceStatus.paid);
    expect(steps.indexOf('sales:sellReserved')).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf('sales:sellReserved')).toBeLessThan(steps.indexOf('grant:insert'));
  });
});
