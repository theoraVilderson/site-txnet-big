import { OutboxEventType } from '@txnet-backend/shared-core';

/**
 * How one retention event is told: auth-service's template, the payload
 * fields passed to it as params, and `optional` ones passed only when the
 * payload has them (the tenant's support link, which it may not have set).
 */
export type RetentionNotice = { template: string; params: readonly string[]; optional?: readonly string[] };

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
export const RETENTION_NOTICES: Partial<Record<OutboxEventType, RetentionNotice>> = {
  // F-601-c: nothing consumed 24 h, then 72 h, after activation — the steps, and the tenant's support.
  [OutboxEventType.GRANT_NOT_CONNECTED]: { template: 'serviceNotConnected', params: [], optional: ['supportUrl'] },
  [OutboxEventType.GRANT_STILL_NOT_CONNECTED]: { template: 'serviceStillNotConnected', params: [], optional: ['supportUrl'] },
};
