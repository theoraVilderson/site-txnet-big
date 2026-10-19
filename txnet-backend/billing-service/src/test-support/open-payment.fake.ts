import { OutboxEventType } from '@txnet-backend/shared-core';

type OutboxData = { type: string; aggregateId: string };

/**
 * What `announceOpenPayment` (RT-1-j) reads and writes, for a spec's fake
 * transaction: `tenant`, `outboxEvent` and `paymentTransferDetail` go on the
 * tx, `findUnique` on its `paymentTransaction`. `paymentTransferDetail` is
 * what a credit reads for a transfer's reference (`recordTransferRef`,
 * F-805-a): none here, so no payment is a transfer. Each announced payment id is collected in `announced`;
 * `outboxEvent(other)` hands every other outbox row to the spec's own recorder,
 * so the specs that order their writes see only the rows they assert.
 */
export function openPaymentFakes(announced: string[] = []) {
  const outboxEvent = (other: (data: OutboxData) => unknown = () => ({ id: 'event' })) => ({
    create: async ({ data }: { data: OutboxData }) => {
      if (data.type !== OutboxEventType.PAYMENT_OPEN_CHANGED) return other(data);
      announced.push(data.aggregateId);
      return { id: 'announce' };
    },
  });
  return {
    announced,
    // No reseller owner, so no `reseller_open_changed` row (F-093-v); `open-payment.spec.ts` proves that one.
    tenant: { findFirst: async () => ({ id: 'platform-tenant' }), findUnique: async () => null },
    paymentTransferDetail: { findUnique: async () => null },
    findUnique: async () => ({ tenantId: null }),
    outboxEvent,
  };
}
