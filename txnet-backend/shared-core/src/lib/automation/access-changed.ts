import { OutboxEventType } from './routing-keys';

/** The outbox `aggregate` of every access change: the person is the aggregate. */
export const ACCESS_AGGREGATE = 'identity.access';

/**
 * Why a person's access moved (AC-1-q). Carried for the notice (AC-1-s); the
 * page only re-reads. `keys_set` is a key given, taken or lifted on the person
 * (AC-1-l). A producer added later (group access, a temporal window) adds its
 * cause here.
 */
export type AccessChangeCause = 'role_set' | 'role_edited' | 'keys_set' | 'seat_removed' | 'seat_restored';

/**
 * What the notice names (AC-1-s): `role_set` the role now held, by its name;
 * `role_edited` and `keys_set` the keys the person's answer gained and lost.
 * The page reads none of it.
 */
export type AccessChangeDetail = { role?: string; given?: string[]; taken?: string[] };

/**
 * The `outbox_event` row for one person's access change, written in the
 * producer's own transaction (ADR-0021). The worker pushes `{type}` to
 * `user:<userId>` (`LIVE_PUSH_FIELDS`); the person's panel refreshes its token
 * and re-reads `me` (AC-1-r). One function, so every producer writes one shape.
 */
export function accessChanged(userId: string, tenantId: string, cause: AccessChangeCause, detail: AccessChangeDetail = {}) {
  return {
    aggregate: ACCESS_AGGREGATE,
    aggregateId: userId,
    type: OutboxEventType.ACCESS_CHANGED,
    payload: { userId, tenantId, cause, ...detail },
  };
}
