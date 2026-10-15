import { OutboxEventType } from '@txnet-backend/shared-core';

type OutboxData = { type: string; aggregateId: string };

/**
 * What `announceOpenPayment` (RT-1-j) reads and writes, for a spec's fake
 * transaction: `tenant` and `outboxEvent` go on the tx, `findUnique` on its
 * `paymentTransaction`. Each announced payment id is collected in `announced`;
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
    tenant: { findFirst: async () => ({ id: 'platform-tenant' }) },
    findUnique: async () => ({ tenantId: null }),
    outboxEvent,
  };
}
