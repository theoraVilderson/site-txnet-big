import type { OutboxEventType } from '@txnet-backend/shared-core';

/** How one retention event is told: auth-service's template, and the payload fields passed to it as params. */
export type RetentionNotice = { template: string; params: readonly string[] };

/**
 * Each retention event type (F-601, spec 9.5) and how it is told (F-601-a).
 * A producing row adds its type here, its template in auth-service's notify
 * seam, and `OUTBOX_EVENT_BINDER` names worker-service for it — the broker
 * binds the retention queue to every key of this table.
 *
 * Every payload carries `tenantId`, `userId`, `grantId` and `period` (the
 * producer's name for the Grant's current period; a renewal opens a new one)
 * besides the params named here, all required.
 *
 * Its own file, not the consumer's: `BrokerService` reads the keys, and the
 * consumer imports the broker.
 */
export const RETENTION_NOTICES: Partial<Record<OutboxEventType, RetentionNotice>> = {};
