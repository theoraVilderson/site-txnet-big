import type { Prisma } from '@prisma/client';

import { OutboxEventType } from './routing-keys';

/** The outbox `aggregate` of every access change: the person is the aggregate. */
export const ACCESS_AGGREGATE = 'identity.access';

/**
 * Why a person's access moved, and is told (AC-1-q). Carried for the notice
 * (AC-1-s), which has one template per cause; the page only re-reads.
 * `keys_set` is a key given, taken or lifted on the person (AC-1-l);
 * `group_access` a group's access changed, or they joined or left one that
 * gives some (AC-1-m). A producer added later (a temporal window) adds its
 * cause here, and its template with it.
 */
export const ACCESS_CHANGE_CAUSES = ['role_set', 'role_edited', 'keys_set', 'group_access', 'seat_removed', 'seat_restored'] as const;
export type AccessChangeCause = (typeof ACCESS_CHANGE_CAUSES)[number];

/**
 * What a history row may name (AC-1-p): every cause above, and the seat's
 * acts nobody is told about — invited (no access until accepted), accepted by
 * the person, and its end moved while it still admits them.
 */
export const ACCESS_HISTORY_CAUSES = [...ACCESS_CHANGE_CAUSES, 'seat_invited', 'seat_joined', 'seat_end_set'] as const;
export type AccessHistoryCause = (typeof ACCESS_HISTORY_CAUSES)[number];

/**
 * What the notice names (AC-1-s): `role_set` the role now held, by its name;
 * `role_edited`, `keys_set` and `group_access` the keys the person's answer
 * gained and lost — which the history row keeps too.
 */
export type AccessChangeDetail = { role?: string; given?: string[]; taken?: string[] };

/**
 * One person's access moved by one act. `actorUserId` did it; `auditLogId` is
 * the act's `admin_audit_log` row (who, before, after, reason), null only for
 * an act that is the person's own.
 */
export type AccessChange = {
  userId: string;
  tenantId: string;
  cause: AccessHistoryCause;
  actorUserId: string;
  auditLogId: string | null;
  detail?: AccessChangeDetail;
};

const TOLD: ReadonlySet<string> = new Set(ACCESS_CHANGE_CAUSES);

/**
 * Record access changes in the producer's own transaction (ADR-0021): one
 * `access_history` row per person (AC-1-p), and for a told cause the
 * `outbox_event` the worker pushes to `user:<userId>` (`LIVE_PUSH_FIELDS`), on
 * which their panel refreshes its token and re-reads `me` (AC-1-r).
 *
 * The only way to write either: `accessChanged` is not exported, so a producer
 * cannot tell a person without the history remembering it.
 */
export async function recordAccessChange(
  tx: Pick<Prisma.TransactionClient, 'outboxEvent' | 'accessHistory'>,
  changes: readonly AccessChange[],
): Promise<void> {
  if (changes.length === 0) return;
  await tx.accessHistory.createMany({
    data: changes.map((c) => ({
      tenantId: c.tenantId,
      userId: c.userId,
      actorUserId: c.actorUserId,
      cause: c.cause,
      auditLogId: c.auditLogId,
      given: c.detail?.given ?? [],
      taken: c.detail?.taken ?? [],
    })),
  });
  const told = changes.filter((c) => TOLD.has(c.cause)).map(accessChanged);
  if (told.length === 1) await tx.outboxEvent.create({ data: told[0], select: { id: true } });
  else if (told.length > 1) await tx.outboxEvent.createMany({ data: told });
}

/** The `outbox_event` row for one person's access change. One function, so every producer writes one shape. */
function accessChanged(c: AccessChange) {
  return {
    aggregate: ACCESS_AGGREGATE,
    aggregateId: c.userId,
    type: OutboxEventType.ACCESS_CHANGED,
    payload: { userId: c.userId, tenantId: c.tenantId, cause: c.cause, ...c.detail },
  };
}
