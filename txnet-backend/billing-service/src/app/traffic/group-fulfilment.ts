import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  ActorType,
  ConfigProtocol,
  ConfigStatus,
  DesiredRemote,
  EnforcementState,
  GrantStatus,
  PanelGroupMemberRole,
  PanelGroupStrategy,
  PanelReviewState,
  PanelState,
  Prisma,
} from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { markDelivered } from '../entitlement/delivered';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService, ConfigActor } from './config-actions';

/**
 * Who placed a group's configs in `config_action_log`: the fulfilment job, not
 * the user whose Grant it is. One fixed id, so the log reads as one actor.
 */
export const GROUP_FULFILMENT_ACTOR: ConfigActor = { actorType: ActorType.system, actorId: '00000000-0000-4000-8000-0000000f027b' };

/** A new client is written only to a panel that answered us cleanly (network `contract.budget.md`). */
const PLACEABLE_PANEL_STATES: readonly PanelState[] = [PanelState.healthy];

/**
 * A panel still serving its users — sub-api's `servingPanelStates` (sub-api
 * contract "What is served"). A config confirmed there counts towards
 * `minHealthyPanels`; `throttled_or_blocked` refuses our admin calls and still
 * serves. A state added later counts only once it is named here and there.
 */
const SERVING_PANEL_STATES: readonly PanelState[] = [PanelState.healthy, PanelState.degraded, PanelState.throttled_or_blocked];

/** Only an accepted panel is collected (network `contract.registration.md`), so only one is placed on. */
const PLACEABLE_REVIEW_STATES: readonly PanelReviewState[] = [PanelReviewState.accepted, PanelReviewState.accepted_low_trust];

/** Declared once (C-09): why a Grant's group was not fulfilled. */
export const GROUP_FULFILMENT_REJECTIONS = ['grant_not_found', 'grant_not_fulfillable', 'no_panel_group', 'strategy_not_built'] as const;
export type GroupFulfilmentRejection = (typeof GROUP_FULFILMENT_REJECTIONS)[number];

export class GroupFulfilmentRefused extends Error {
  constructor(
    readonly reason: GroupFulfilmentRejection,
    detail = '',
  ) {
    super(`group fulfilment refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'GroupFulfilmentRefused';
  }
}

type MemberFacts = { panelId: string; role: PanelGroupMemberRole; panel: { reviewState: PanelReviewState; panelState: PanelState } };

/**
 * A member a new config may be placed on now: not `drain`, its panel accepted
 * and healthy. What catalog's group list counts as healthy (F-026-p), so the
 * figure an admin picks by is the one fulfilment acts on.
 */
export const placeableMember = (m: Pick<MemberFacts, 'role' | 'panel'>): boolean =>
  m.role !== PanelGroupMemberRole.drain && PLACEABLE_REVIEW_STATES.includes(m.panel.reviewState) && PLACEABLE_PANEL_STATES.includes(m.panel.panelState);
type ConfigFacts = {
  panelId: string;
  status: ConfigStatus;
  desiredRemote: DesiredRemote;
  enforcementState: EnforcementState;
  credentialGroupId: string | null;
  drainedAt: Date | null;
};

export type FulfilmentFacts = {
  grantStatus: GrantStatus;
  group: { strategy: PanelGroupStrategy; minHealthyPanels: number; members: MemberFacts[] };
  configs: ConfigFacts[];
};

export type FulfilmentPlan = {
  /** Members to place a config on now, in panel-id order. */
  place: string[];
  /** Non-drain members with no config that cannot be placed on yet — retried when they can. */
  waiting: string[];
  /** A `pending` Grant has `minHealthyPanels` confirmed configs on serving panels. */
  activate: boolean;
  /** The group's id if one of the Grant's configs already carries it; null means a new one. */
  credentialGroupId: string | null;
};

/**
 * `mirror` over what is true now (network `contract.groups.md` rule 7). Pure,
 * so the same facts give the same plan in any member order.
 *
 * **A panel with any config of this Grant is covered**, whatever its status: a
 * row still `pending` on a panel that died mid-provisioning is carried by the
 * convergence pass when it returns, and a retired one was a decision (a
 * delete, or a move away) that a refill would undo. That is what keeps it to
 * one config per panel, and the partial unique index
 * `config_group_panel_once` holds the same line against two concurrent runs.
 * **Except a drained one** (`drainedAt`, F-027-bp): the platform emptied the
 * panel, the user decided nothing, so a member re-added is placed again.
 */
export function planFulfilment(facts: FulfilmentFacts): FulfilmentPlan {
  const covered = new Set(facts.configs.filter((c) => !c.drainedAt).map((c) => c.panelId));
  const members = [...facts.group.members].sort((a, b) => a.panelId.localeCompare(b.panelId));
  const open = members.filter((m) => m.role !== PanelGroupMemberRole.drain && !covered.has(m.panelId));
  const placeable = placeableMember;

  const serving = new Set(members.filter((m) => SERVING_PANEL_STATES.includes(m.panel.panelState)).map((m) => m.panelId));
  const confirmed = facts.configs.filter(
    (c) =>
      c.status === ConfigStatus.active &&
      c.desiredRemote === DesiredRemote.present &&
      c.enforcementState === EnforcementState.complete &&
      serving.has(c.panelId),
  ).length;

  return {
    place: open.filter(placeable).map((m) => m.panelId),
    waiting: open.filter((m) => !placeable(m)).map((m) => m.panelId),
    activate: facts.grantStatus === GrantStatus.pending && confirmed >= facts.group.minHealthyPanels,
    credentialGroupId: facts.configs.find((c) => c.credentialGroupId !== null)?.credentialGroupId ?? null,
  };
}

export type Fulfilment = { placed: number; waiting: string[]; activated: boolean };
export type FulfilDueResult = { scanned: number; configsPlaced: number; grantsActivated: number; grantsFailed: number };

/** Grants per sweep. The scan names only Grants with a write due, so a batch drains. */
const FULFIL_BATCH_SIZE = 200;

/**
 * Group fulfilment (F-027-bl, catalog §7.3): a Grant of a variant with a panel
 * group gets a config on every non-drain healthy member, and activates once
 * `minHealthyPanels` of them are confirmed by the panel.
 *
 * It writes desired state and nothing else — `ConfigActionsService` makes the
 * rows and `network-service`'s convergence pass creates the clients (ADR-0075).
 * **The retry is the loop, not a counter.** A member that is down, in
 * maintenance or not yet accepted is left `waiting`; the sweep names a Grant
 * again once one of its members can be placed on, so a panel that returns is
 * filled on the next tick after it does. The panel-side backoff is the
 * convergence pass's own, per panel (`contract.budget.md` cool-off).
 */
@Injectable()
export class GroupFulfilmentService {
  private readonly logger = new Logger(GroupFulfilmentService.name);

  constructor(
    private readonly actions: ConfigActionsService,
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  /** One Grant, in the caller's transaction. Safe to run twice: a covered panel is never placed on again. */
  async fulfil(tx: Prisma.TransactionClient, grantId: string): Promise<Fulfilment> {
    const grant = await tx.grant.findUnique({
      where: { id: grantId },
      select: {
        id: true,
        status: true,
        variant: {
          select: {
            panelGroup: {
              select: {
                strategy: true,
                minHealthyPanels: true,
                protocol: true,
                members: { select: { panelId: true, role: true, panel: { select: { reviewState: true, panelState: true } } } },
              },
            },
          },
        },
      },
    });
    if (!grant) throw new GroupFulfilmentRefused('grant_not_found', grantId);
    if (grant.status !== GrantStatus.pending && grant.status !== GrantStatus.active) throw new GroupFulfilmentRefused('grant_not_fulfillable', grant.status);
    const group = grant.variant.panelGroup;
    if (!group) throw new GroupFulfilmentRefused('no_panel_group', grantId);
    // `priority` and `weighted` were declared with no fulfilment behind them
    // (contract.groups.md rule 7): refused, never placed as `mirror`.
    if (group.strategy !== PanelGroupStrategy.mirror) throw new GroupFulfilmentRefused('strategy_not_built', group.strategy);

    const configs = await tx.config.findMany({
      where: { grantId },
      select: { panelId: true, status: true, desiredRemote: true, enforcementState: true, credentialGroupId: true, drainedAt: true },
    });
    const plan = planFulfilment({ grantStatus: grant.status, group, configs });

    const made = await this.actions.provisionForGroup(tx, {
      grantId,
      panelIds: plan.place,
      protocol: group.protocol as ConfigProtocol,
      credentialGroupId: plan.credentialGroupId ?? randomUUID(),
      actor: GROUP_FULFILMENT_ACTOR,
    });

    // Conditional on `pending`: an admin's cancel or a refund meanwhile stands.
    // Delivered with its outbox event, so the buyer is told (F-111-d).
    const activated = plan.activate ? await markDelivered(tx, grantId) : false;
    return { placed: made.length, waiting: plan.waiting, activated };
  }

  /**
   * One sweep, for `worker-service`'s tick. **The scan names only Grants with
   * a write due** — a placeable member with no config of the Grant, or a
   * `pending` Grant with enough confirmed configs — so a Grant waiting on a
   * down panel does not occupy a batch slot, and a second call finds nothing
   * (ADR-0027). The scan is cross-tenant; each write runs in its tenant.
   */
  async fulfilDue(): Promise<FulfilDueResult> {
    const due = await this.crossTenant.$queryRaw<{ id: string; tenantId: string }[]>`
      SELECT g."id", g."tenantId"
        FROM "entitlement"."grant" g
        JOIN "catalog"."product_variant" v ON v."id" = g."variantId"
        JOIN "network"."panel_group" pg ON pg."id" = v."panelGroupId"
       WHERE g."status" IN ('pending', 'active')
         AND pg."strategy" = 'mirror'
         AND (
               EXISTS (
                 SELECT 1 FROM "network"."panel_group_member" m
                   JOIN "network"."panel" p ON p."id" = m."panelId"
                  WHERE m."groupId" = pg."id"
                    AND m."role" <> 'drain'
                    AND p."reviewState" IN ('accepted', 'accepted_low_trust')
                    AND p."panelState" = 'healthy'
                    AND NOT EXISTS (SELECT 1 FROM "network"."config" c
                                    WHERE c."grantId" = g."id" AND c."panelId" = m."panelId" AND c."drainedAt" IS NULL))
            OR (g."status" = 'pending' AND pg."minHealthyPanels" <= (
                 SELECT count(*) FROM "network"."config" c
                   JOIN "network"."panel" p ON p."id" = c."panelId"
                   JOIN "network"."panel_group_member" m ON m."groupId" = pg."id" AND m."panelId" = c."panelId"
                  WHERE c."grantId" = g."id"
                    AND c."status" = 'active' AND c."desiredRemote" = 'present' AND c."enforcementState" = 'complete'
                    AND p."panelState" IN ('healthy', 'degraded', 'throttled_or_blocked')))
         )
       ORDER BY g."createdAt" ASC
       LIMIT ${FULFIL_BATCH_SIZE}`;

    const result: FulfilDueResult = { scanned: due.length, configsPlaced: 0, grantsActivated: 0, grantsFailed: 0 };
    for (const grant of due) {
      try {
        const done = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.fulfil(tx, grant.id)));
        result.configsPlaced += done.placed;
        if (done.activated) result.grantsActivated += 1;
      } catch (e) {
        // One Grant's failure — a concurrent run winning `config_group_panel_once`,
        // a status that moved — is that Grant's; the next tick names it again.
        result.grantsFailed += 1;
        this.logger.warn(`group fulfilment of grant ${grant.id} failed: ${(e as Error).message}`);
      }
    }
    if (result.configsPlaced > 0 || result.grantsActivated > 0) {
      this.logger.log(`placed ${result.configsPlaced} config(s), activated ${result.grantsActivated} of ${due.length} Grant(s)`);
    }
    return result;
  }
}
