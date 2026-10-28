import { Injectable } from '@nestjs/common';
import { ActorType, GrantStatus, PanelGroupMemberRole, Prisma } from '@prisma/client';

import { assertPlatformGrantRoom } from '../entitlement/reseller-room';
import { AuditActor, auditedConfigAct, auditedGrantRegroup } from '../grant-audit/grant-audit';
import { ConfigActionsService } from './config-actions';
import { deliverableGroupIds, GroupFulfilmentService } from './group-fulfilment';
import { groupHasRoom, LIVE_CONFIG, MemberFacts } from './group-plan';
import { onPlatformPanel, soldWithoutLeg } from './vpn-wholesale';

/** Declared once (C-09): why one Grant was not moved to another group. */
export const GRANT_REGROUP_REJECTIONS = [
  'grant_not_found',
  'grant_not_movable',
  'same_group',
  'group_not_found',
  'group_not_for_grant',
  'target_not_deliverable',
  'target_full',
  'no_target',
  'wholesale_rate_missing',
] as const;
export type GrantRegroupRejection = (typeof GRANT_REGROUP_REJECTIONS)[number];

/** Each refusal as its HTTP status, on every surface that moves a Grant: absent, or a state the target or Grant is in. */
export const GRANT_REGROUP_STATUS: Record<GrantRegroupRejection, 404 | 409> = {
  grant_not_found: 404,
  group_not_found: 404,
  grant_not_movable: 409,
  same_group: 409,
  group_not_for_grant: 409,
  target_not_deliverable: 409,
  target_full: 409,
  no_target: 409,
  wholesale_rate_missing: 409,
};

export class GrantRegroupRefused extends Error {
  constructor(
    readonly reason: GrantRegroupRejection,
    detail = '',
  ) {
    super(`grant regroup refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'GrantRegroupRefused';
  }
}

/** A Grant fulfilment still serves and can place again: the only ones a move may take. */
const MOVABLE: ReadonlySet<GrantStatus> = new Set([GrantStatus.pending, GrantStatus.active]);

export type RegroupConfig = { id: string; panelId: string; inboundRemoteId: string | null };

/** `bounded`: the reseller's own people, held to its platform-panel room (ADR-0106); the owner and platform staff are not. */
export type RegroupInput = { grantId: string; toGroupId: string; actor: AuditActor; reason: string; bounded: boolean };

export type Regrouped = { grantId: string; fromGroupId: string; toGroupId: string; kept: number; moved: number };

/**
 * Which of a Grant's live configs keep their link in the target group (ADR-0127
 * decision 5): one on a panel the target holds, not draining, on an inbound the
 * target sells there — listed to it or every group's (`sellingInbounds`, as
 * `membersOf` loaded it). A row placed before inbounds were picked
 * (`inboundRemoteId` null) holds the whole panel, so any such member keeps it.
 * `full`: a kept config finds the target's own seats taken — its share of the
 * inbound or its member cap (F-027-eq). Pure.
 */
export function splitForTarget(configs: RegroupConfig[], target: MemberFacts[]): { kept: RegroupConfig[]; moved: RegroupConfig[]; full: boolean } {
  const kept: RegroupConfig[] = [];
  const moved: RegroupConfig[] = [];
  let full = false;
  for (const c of configs) {
    const m = target.find((t) => t.panelId === c.panelId && t.role !== PanelGroupMemberRole.drain);
    const sold = c.inboundRemoteId === null ? null : (m?.panel.inbounds.find((i) => i.remoteId === c.inboundRemoteId) ?? undefined);
    if (!m || sold === undefined) {
      moved.push(c);
      continue;
    }
    kept.push(c);
    if (!groupHasRoom(m.panel, sold)) full = true;
  }
  return { kept, moved, full };
}

/**
 * Moving one Grant to another panel group (F-027-et, ADR-0127 decision 5), in
 * the caller's transaction, in the Grant's tenant. **Only `panelGroupId`
 * changes**: money, quota and end stay. A config the target also sells where
 * it is stays — same client, same link. Every other one is drained (audited as
 * `config_move`, the user told) and the target's fulfilment places the Grant
 * in the same transaction, under its panels' locks, against every cap.
 *
 * Refused before anything is written: a Grant with no group or not serving, the
 * same group, a group it may not use (a platform group or its own tenant's —
 * `grant_panel_group_fits`), one that cannot deliver a sale (F-111-i), one
 * holding a platform panel for a Grant sold with no wholesale leg (F-118-n7),
 * or one whose seats a kept config would overfill. Refused **after**, rolling back: a
 * Grant that held a line and would be left with none (`no_target`).
 */
@Injectable()
export class GrantRegroupActs {
  constructor(
    private readonly actions: ConfigActionsService,
    private readonly fulfilment: GroupFulfilmentService,
  ) {}

  async regroup(tx: Prisma.TransactionClient, input: RegroupInput): Promise<Regrouped> {
    const grant = await tx.grant.findUnique({ where: { id: input.grantId }, select: { id: true, tenantId: true, status: true, panelGroupId: true } });
    if (!grant) throw new GrantRegroupRefused('grant_not_found', input.grantId);
    const fromGroupId = grant.panelGroupId;
    if (!fromGroupId || !MOVABLE.has(grant.status)) throw new GrantRegroupRefused('grant_not_movable', grant.status);
    if (fromGroupId === input.toGroupId) throw new GrantRegroupRefused('same_group', fromGroupId);
    await this.assertTarget(tx, grant.tenantId, input.toGroupId);
    if ((await onPlatformPanel(tx, input.toGroupId)) && (await soldWithoutLeg(tx, grant))) throw new GrantRegroupRefused('wholesale_rate_missing', input.toGroupId);
    // One more open Grant on the platform's panels only if it was not on them already.
    if (input.bounded && !(await onPlatformPanel(tx, fromGroupId))) await assertPlatformGrantRoom(tx, input.toGroupId);

    const target = await this.fulfilment.membersOf(tx, input.toGroupId);
    const configs = await tx.config.findMany({ where: { grantId: grant.id, ...LIVE_CONFIG }, select: { id: true, panelId: true, inboundRemoteId: true } });
    const { kept, moved, full } = splitForTarget(configs, target);
    if (full) throw new GrantRegroupRefused('target_full', input.toGroupId);

    const actor = { actorType: ActorType.admin, actorId: input.actor.userId };
    return auditedGrantRegroup(tx, input.actor, grant.tenantId, grant.id, input.reason, async () => {
      await tx.grant.update({ where: { id: grant.id }, data: { panelGroupId: input.toGroupId } });
      for (const c of moved) {
        await auditedConfigAct(tx, input.actor, grant.tenantId, c.id, 'config_move', input.reason, () => this.actions.drain(tx, { configId: c.id, actor }));
      }
      await this.fulfilment.fulfil(tx, grant.id);
      if (configs.length > 0 && (await tx.config.count({ where: { grantId: grant.id, ...LIVE_CONFIG } })) === 0) throw new GrantRegroupRefused('no_target', input.toGroupId);
      return { grantId: grant.id, fromGroupId, toGroupId: input.toGroupId, kept: kept.length, moved: moved.length };
    });
  }

  /** A group the Grant may use — the platform's or its own tenant's — that can deliver a sale now. */
  private async assertTarget(tx: Prisma.TransactionClient, grantTenantId: string, groupId: string) {
    const group = await tx.panelGroup.findUnique({ where: { id: groupId }, select: { tenantId: true } });
    if (!group) throw new GrantRegroupRefused('group_not_found', groupId);
    if (group.tenantId !== null && group.tenantId !== grantTenantId) throw new GrantRegroupRefused('group_not_for_grant', groupId);
    if (!(await deliverableGroupIds(tx, [groupId])).has(groupId)) throw new GrantRegroupRefused('target_not_deliverable', groupId);
  }
}
