import { OutboxEventType, outboxRoutingKey } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The outbox events that wake the engine for one account (ADR-0109 point 6).
 * Imported from shared-core, never spelled here (C-08). Hourly profile
 * rebuilds (F-038-c) cover everything else; this list is only what should not
 * wait an hour. Nothing from the network layer.
 */
export const AI_TRIGGER_EVENTS = [
  OutboxEventType.PAYMENT_CONFIRMED,
  OutboxEventType.GRANT_CREATED,
  OutboxEventType.GRANT_REACTIVATED,
  OutboxEventType.GRANT_ENDED,
  OutboxEventType.GRANT_VOLUME_SPENT,
  OutboxEventType.GRANT_WALLET_SPENT,
  OutboxEventType.GRANT_RUNS_OUT_SOON,
  OutboxEventType.GRANT_RUNS_OUT_WITHIN_A_DAY,
  OutboxEventType.GRANT_LOW_BALANCE,
  OutboxEventType.TENANT_QUOTA_ALERT,
] as const;

export const AI_TRIGGER_ROUTING_KEYS = AI_TRIGGER_EVENTS.map(outboxRoutingKey);

/** The relay's envelope (`OutboxMessage`). The payload is the producer's; a handler parses what it needs. */
export const triggerMessageSchema = z.object({
  id: z.string().uuid(),
  aggregate: z.string().min(1),
  aggregateId: z.string().min(1),
  type: z.enum(AI_TRIGGER_EVENTS),
  occurredAt: z.string().datetime({ offset: true }),
  payload: z.unknown(),
});

export type TriggerMessage = z.infer<typeof triggerMessageSchema>;
