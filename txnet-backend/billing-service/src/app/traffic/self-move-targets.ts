import { ActorType, ConfigStatus, PanelGroupMemberRole, PanelGroupStrategy, Prisma } from '@prisma/client';

import { moveTargetWhere } from '../payment/gift/config-move-selection';
import { CONFIG_MOVE_OUT_ACTION, ConfigActionRefused } from './config-actions';
import { selfMoveSettingOf } from './self-move-setting';

/** More members than one group ever has: the list is bounded all the same (C-28). */
export const MAX_SELF_MOVE_TARGETS = 100;

/** One hour, in the milliseconds a `Date` counts. */
export const HOUR_MS = 3_600_000;

/**
 * Where a user may move one of their configs, and from when (F-410-b). A panel
 * is its id and region only — never its name or address, as the config list
 * answers (user, 2026-10-22). `nextMoveAt` null = now.
 */
export type SelfMoveTargets = {
  configId: string;
  enabled: boolean;
  cooldownHours: number;
  /** ISO time the wait ends; null when there is none left. */
  nextMoveAt: string | null;
  panels: { id: string; region: string }[];
};

/** What a move reads before it acts (F-410-c): the targets, and what only the act needs. */
export type SelfMoveState = {
  view: SelfMoveTargets;
  grantId: string;
  /** Fulfilment places this Grant on every member of its group (`mirror`): a line moved off one would be put back. */
  placedByGroup: boolean;
};

/**
 * The targets of a user's own move (F-410-b, `network/contract.config-move.md`
 * "Self-move"). **Only panels the product already allows** (D-63): the members
 * of the Grant's own group (`grant.panelGroupId`, never the variant's —
 * ADR-0127 decision 4) not draining, whose panel is a move target
 * (`moveTargetWhere`: accepted, not retired, shared or the Grant's tenant's),
 * and on which the Grant holds no live config. A Grant of no group has none,
 * and a `mirror` Grant — on every member by rule — is offered none either,
 * even beside a member fulfilment has not reached yet.
 *
 * Another user's config reads as absent (`config_not_found`), as everywhere a
 * user names a config. Runs in the caller's tenant transaction; reads only.
 */
export async function selfMoveTargets(tx: Prisma.TransactionClient, userId: string, configId: string, now: Date): Promise<SelfMoveTargets> {
  return (await readSelfMove(tx, userId, configId, now)).view;
}

/** {@link selfMoveTargets}, with the Grant it read — the one home of the rules both the list and the move hold. */
export async function readSelfMove(tx: Prisma.TransactionClient, userId: string, configId: string, now: Date): Promise<SelfMoveState> {
  const config = await tx.config.findUnique({
    where: { id: configId },
    select: {
      userId: true,
      status: true,
      tenantId: true,
      grantId: true,
      grant: { select: { panelGroupId: true, panelGroup: { select: { strategy: true } }, variant: { select: { productId: true } } } },
    },
  });
  if (!config || config.userId !== userId) throw new ConfigActionRefused('config_not_found', configId);
  if (config.status === ConfigStatus.retired) throw new ConfigActionRefused('config_retired', configId);

  const { grantId } = config;
  const placedByGroup = config.grant.panelGroup?.strategy === PanelGroupStrategy.mirror;
  const setting = await selfMoveSettingOf(tx, config.tenantId, config.grant.variant?.productId ?? null);
  const enabled = setting.enabled.value;
  const cooldownHours = setting.cooldownHours.value;
  if (!enabled) return { grantId, placedByGroup, view: { configId, enabled, cooldownHours, nextMoveAt: null, panels: [] } };

  const groupId = config.grant.panelGroupId;
  const placeable = groupId !== null && !placedByGroup;
  return {
    grantId,
    placedByGroup,
    view: {
      configId,
      enabled,
      cooldownHours,
      nextMoveAt: await nextMoveAt(tx, grantId, cooldownHours, now),
      panels: placeable ? await groupTargets(tx, groupId, grantId, config.tenantId) : [],
    },
  };
}

/** The wait counts from the Grant's last move by its own user — a move leaves a config, so it is the Grant's, not the config's. */
async function nextMoveAt(tx: Prisma.TransactionClient, grantId: string, cooldownHours: number, now: Date): Promise<string | null> {
  const last = await tx.configActionLog.findFirst({
    where: { action: CONFIG_MOVE_OUT_ACTION, actorType: ActorType.user, config: { grantId } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!last) return null;
  const ends = new Date(last.createdAt.getTime() + cooldownHours * HOUR_MS);
  return ends > now ? ends.toISOString() : null;
}

async function groupTargets(tx: Prisma.TransactionClient, groupId: string, grantId: string, tenantId: string): Promise<{ id: string; region: string }[]> {
  const held = await tx.config.findMany({ where: { grantId, status: { not: ConfigStatus.retired }, drainedAt: null }, select: { panelId: true } });
  const members = await tx.panelGroupMember.findMany({
    where: {
      groupId,
      role: { not: PanelGroupMemberRole.drain },
      panelId: { notIn: held.map((c) => c.panelId) },
      panel: moveTargetWhere(tenantId),
    },
    select: { panel: { select: { id: true, region: true } } },
    orderBy: [{ panel: { region: 'asc' } }, { panelId: 'asc' }],
    take: MAX_SELF_MOVE_TARGETS,
  });
  return members.map((m) => m.panel);
}
