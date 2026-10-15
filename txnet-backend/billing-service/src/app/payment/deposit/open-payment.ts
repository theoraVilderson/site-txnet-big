import { PaymentStatus, Prisma } from '@prisma/client';
import { OutboxEventType, platformTenantIdOf } from '@txnet-backend/shared-core';

/**
 * RT-1-j: the manual-payments list (`ManualConfirmService.list`) is every open
 * payment — `pending` or `expired` — and the platform owner reads every
 * tenant's. A write that adds, moves or settles one announces it here, in its
 * own transaction, to the payment's tenant and to the platform owner: one
 * outbox row each, routed to `tenant:<id>` by live-push. Ids only — the page
 * re-reads its own list (ADR-0121).
 */
export async function announceOpenPayment(tx: Prisma.TransactionClient, paymentId: string): Promise<void> {
  const [row, platformId] = await Promise.all([
    tx.paymentTransaction.findUnique({ where: { id: paymentId }, select: { tenantId: true } }),
    platformTenantIdOf(tx),
  ]);
  const tenants = new Set([row?.tenantId ?? platformId, platformId]);
  for (const tenantId of tenants) {
    await tx.outboxEvent.create({
      data: { aggregate: 'billing.payment', aggregateId: paymentId, type: OutboxEventType.PAYMENT_OPEN_CHANGED, payload: { tenantId, paymentId } },
    });
  }
}

/**
 * Close an open payment with `data`: `pending` tried first, then `expired`
 * (ADR-0046 decision 1) — which one matched is what says whether its coupon
 * holds are still held, so it is the answer; `null` when another path settled
 * it first. Announced only when it matched.
 */
export async function settleOpen(
  tx: Prisma.TransactionClient,
  paymentId: string,
  data: Prisma.PaymentTransactionUpdateManyMutationInput,
  where: Prisma.PaymentTransactionWhereInput = {},
): Promise<PaymentStatus | null> {
  for (const from of [PaymentStatus.pending, PaymentStatus.expired]) {
    const { count } = await tx.paymentTransaction.updateMany({ where: { ...where, id: paymentId, status: from }, data });
    if (count !== 1) continue;
    await announceOpenPayment(tx, paymentId);
    return from;
  }
  return null;
}
