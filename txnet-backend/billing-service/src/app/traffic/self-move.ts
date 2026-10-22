import { ActorType, Prisma } from '@prisma/client';

import type { ConfigActionsService } from './config-actions';
import { HOUR_MS, readSelfMove } from './self-move-targets';

/**
 * Why a user's own move wrote nothing, besides `ConfigActions`' own refusals —
 * one tuple (C-09), because the panel names each to the user (F-410-d).
 */
export const SELF_MOVE_REJECTIONS = [
  /** The tenant (or the product) switched self-move off (F-410-a). */
  'move_disabled',
  /** A `mirror` Grant is on every member by rule; fulfilment would put the line back. */
  'placed_by_group',
  /** Inside the wait after the Grant's last move by its user; `nextMoveAt` says when it ends. */
  'move_cooldown',
  /** Not a panel `move-targets` offers (F-410-b). */
  'not_a_target',
] as const;
export type SelfMoveRejection = (typeof SELF_MOVE_REJECTIONS)[number];

export class SelfMoveRefused extends Error {
  constructor(
    readonly reason: SelfMoveRejection,
    /** Set on `move_cooldown`: the ISO time the next move is allowed. */
    readonly nextMoveAt: string | null = null,
  ) {
    super(`self move refused: ${reason}${nextMoveAt ? ` (until ${nextMoveAt})` : ''}`);
    this.name = 'SelfMoveRefused';
  }
}

/** The answer of a user's move: the new config, where it is served, and when the next move is allowed (null = now). */
export type SelfMoveResult = {
  retiredConfigId: string;
  configId: string;
  panel: { id: string; region: string };
  nextMoveAt: string | null;
};

/**
 * A user moves one of their configs (F-410-c, `network/contract.config-move.md`
 * "Self-move"): at once, free, no approval — to a panel F-410-b offers and
 * nowhere else, so the list and the act cannot disagree (`readSelfMove` is
 * both). The act is `ConfigActions.move` as the user: its `move_out` row,
 * actor `user`, is what the next wait counts from.
 *
 * **The Grant is locked first** (`FOR UPDATE`): the wait is the Grant's, so two
 * moves of two of its configs racing would both pass a check read before the
 * other committed. Under the lock the second reads the first's `move_out`.
 *
 * The new config's lines reach the page by `network.grant.linksCaptured` when
 * network-service captures them (F-111-l, C-14) — nothing is announced here.
 * Runs in the caller's tenant transaction.
 */
export async function selfMove(
  tx: Prisma.TransactionClient,
  actions: Pick<ConfigActionsService, 'move'>,
  input: { userId: string; configId: string; toPanelId: string; now: Date },
): Promise<SelfMoveResult> {
  await tx.$queryRaw`
    SELECT g.id FROM "entitlement"."grant" g JOIN "network"."config" c ON c."grantId" = g.id
     WHERE c.id = ${input.configId}::uuid FOR UPDATE OF g`;
  const { view, placedByGroup } = await readSelfMove(tx, input.userId, input.configId, input.now);
  if (!view.enabled) throw new SelfMoveRefused('move_disabled');
  if (placedByGroup) throw new SelfMoveRefused('placed_by_group');
  if (view.nextMoveAt !== null) throw new SelfMoveRefused('move_cooldown', view.nextMoveAt);
  const panel = view.panels.find((p) => p.id === input.toPanelId);
  if (!panel) throw new SelfMoveRefused('not_a_target');

  const moved = await actions.move(tx, { configId: input.configId, toPanelId: panel.id, actor: { actorType: ActorType.user, actorId: input.userId } });
  return {
    retiredConfigId: moved.retiredConfigId,
    configId: moved.configId,
    panel,
    nextMoveAt: view.cooldownHours > 0 ? new Date(input.now.getTime() + view.cooldownHours * HOUR_MS).toISOString() : null,
  };
}
