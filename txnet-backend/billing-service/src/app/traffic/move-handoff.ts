import { ActorType, ConfigStatus, Prisma } from '@prisma/client';

/**
 * The handoff of a move (ADR-0160 decision 11, F-1601-d2): the row a move
 * leaves keeps serving — status, desired state and its client untouched —
 * until the row that replaced it is confirmed on its panel (`confirmedAt`),
 * then {@link MOVE_GRACE_DAYS} days, so a user who typed a login or copied a
 * config by hand is never cut off while changing their device. Both rows draw
 * on the one Grant. `MoveHandoffService` is the clock; these are the writes
 * `ConfigActionsService.move` makes. Its answer's `retiredConfigId` keeps its
 * wire name (self-move, C-37): the row left, retired by the handoff.
 */

/** Days the old row serves after its replacement is confirmed and the user told (ADR-0160 decision 11). */
export const MOVE_GRACE_DAYS = 3;

/** Who retires a row the handoff is done with, in `config_action_log`: the sweep, or a later move of its replacement. */
export const MOVE_HANDOFF_ACTOR = { actorType: ActorType.system, actorId: '00000000-0000-4000-8000-000000f1601d' };

/** The `GRANT_LINKS_CAPTURED` cause the sweep's retire carries: a live re-read only, never the "lines changed" notice. */
export const MOVE_HANDOFF_CAUSE = 'move_handoff';

/** The live rows still waiting on this one — at most one, since a move retires the waiting row before it adds another. */
export function waitingOn(tx: Prisma.TransactionClient, configId: string) {
  return tx.config.findMany({
    where: { supersededById: configId, status: { not: ConfigStatus.retired } },
    select: { id: true, tenantId: true, userId: true, grantId: true, panelId: true, protocol: true, status: true, regenerateUsedCount: true, maxRegenerateCount: true, supersededById: true },
  });
}

/**
 * The row a move leaves now waits on its replacement. Conditional on what the
 * move read, as every config write is: a row another action moved meanwhile
 * is not linked twice.
 */
export async function handOver(tx: Prisma.TransactionClient, config: { id: string; status: ConfigStatus }, replacementId: string): Promise<boolean> {
  const { count } = await tx.config.updateMany({ where: { id: config.id, status: config.status, supersededById: null }, data: { supersededById: replacementId } });
  return count === 1;
}
