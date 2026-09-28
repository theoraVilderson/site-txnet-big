import { OutboxEventType } from './routing-keys';

/**
 * The retention notice kinds a user may mute (F-601-m, spec 9.4), in the
 * panel's order: usage and wallet levels, the time levels before an end,
 * "trouble connecting?", and "your service runs again".
 */
export const RETENTION_MUTABLE_KINDS = ['usage', 'ending', 'connect', 'reactivated'] as const;
export type RetentionMutableKind = (typeof RETENTION_MUTABLE_KINDS)[number];

/** Every kind. `cutoff` — the service stopped, or its configs are about to go — is never muted nor held for quiet hours. */
export type RetentionKind = RetentionMutableKind | 'cutoff';

/**
 * Each retention notice type's kind. notification-service reads it at the
 * claim, so the ledger — not the caller — decides what a mute covers; a type
 * missing here is told as `cutoff`, never dropped. worker-service's spec holds
 * every `RETENTION_NOTICES` key to a row here.
 */
export const RETENTION_KIND_OF: Readonly<Partial<Record<OutboxEventType, RetentionKind>>> = {
  [OutboxEventType.GRANT_USAGE_50]: 'usage',
  [OutboxEventType.GRANT_USAGE_80]: 'usage',
  [OutboxEventType.GRANT_USAGE_95]: 'usage',
  [OutboxEventType.GRANT_LOW_BALANCE]: 'usage',
  [OutboxEventType.GRANT_RUNS_OUT_SOON]: 'usage',
  [OutboxEventType.GRANT_RUNS_OUT_WITHIN_A_DAY]: 'usage',
  [OutboxEventType.GRANT_ENDS_IN_7D]: 'ending',
  [OutboxEventType.GRANT_ENDS_IN_3D]: 'ending',
  [OutboxEventType.GRANT_ENDS_IN_1D]: 'ending',
  [OutboxEventType.GRANT_NOT_CONNECTED]: 'connect',
  [OutboxEventType.GRANT_STILL_NOT_CONNECTED]: 'connect',
  [OutboxEventType.GRANT_IDLE]: 'connect',
  [OutboxEventType.GRANT_REACTIVATED]: 'reactivated',
  [OutboxEventType.GRANT_ENDED]: 'cutoff',
  [OutboxEventType.GRANT_VOLUME_SPENT]: 'cutoff',
  [OutboxEventType.GRANT_WALLET_SPENT]: 'cutoff',
  [OutboxEventType.GRANT_PURGE_SOON]: 'cutoff',
  [OutboxEventType.GRANT_PURGE_SOON_METERED]: 'cutoff',
  // F-311-s: an admin's act — the service stopped, gone or its link dead is `cutoff`; the rest file under the kind they change.
  [OutboxEventType.GRANT_ADMIN_FROZEN]: 'cutoff',
  [OutboxEventType.GRANT_ADMIN_DELETED]: 'cutoff',
  [OutboxEventType.GRANT_ADMIN_LINK_ROTATED]: 'cutoff',
  [OutboxEventType.GRANT_ADMIN_UNFROZEN]: 'reactivated',
  [OutboxEventType.GRANT_ADMIN_DAYS_ADDED]: 'ending',
  [OutboxEventType.GRANT_ADMIN_DAYS_REMOVED]: 'ending',
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED]: 'usage',
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_REMOVED]: 'usage',
  [OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET]: 'usage',
};

export function retentionKindOf(notice: string): RetentionKind {
  return RETENTION_KIND_OF[notice as OutboxEventType] ?? 'cutoff';
}
