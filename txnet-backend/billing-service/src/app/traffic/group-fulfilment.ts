import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  ActorType,
  ConfigProtocol,
  ConfigStatus,
  DesiredRemote,
  EnforcementState,
  GrantStatus,
  InboundPlacement,
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
import { ConfigActionsService, ConfigActor, InboundPlacementTarget } from './config-actions';

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

/**
 * A member's panel as fulfilment reads it: its health, how it places, its cap,
 * and only the inbounds a buyer may be placed on (network `contract.inbounds.md`
 * rule 2) — the unpicked, disabled and gone ones are never loaded.
 */
const MEMBER_PANEL_FIELDS = {
  reviewState: true,
  panelState: true,
  inboundPlacement: true,
  maxClients: true,
  inbounds: {
    where: { sold: true, enabled: true, goneAt: null, protocol: { not: null } },
    select: { remoteId: true, protocol: true, maxClients: true },
  },
} satisfies Prisma.PanelSelect;

type MemberRow = { panelId: string; role: PanelGroupMemberRole; panel: Prisma.PanelGetPayload<{ select: typeof MEMBER_PANEL_FIELDS }> };

/** A picked inbound as fulfilment reads it: `sold`, enabled, not gone, of a known protocol (F-114-b). */
export type InboundFacts = { remoteId: string; protocol: ConfigProtocol; maxClients: number | null; clients: number };

type PanelFacts = {
  reviewState: PanelReviewState;
  panelState: PanelState;
  inboundPlacement: InboundPlacement;
  maxClients: number | null;
  /** Grants holding a live config on the panel — what `maxClients` caps. */
  users: number;
  inbounds: InboundFacts[];
};

type MemberFacts = { panelId: string; role: PanelGroupMemberRole; panel: PanelFacts };

/**
 * A member a new config may be placed on now: not `drain`, its panel accepted
 * and healthy. What catalog's group list counts as healthy (F-026-p), so the
 * figure an admin picks by is the one fulfilment acts on.
 */
export const placeableMember = (m: { role: PanelGroupMemberRole; panel: Pick<PanelFacts, 'reviewState' | 'panelState'> }): boolean =>
  m.role !== PanelGroupMemberRole.drain && PLACEABLE_REVIEW_STATES.includes(m.panel.reviewState) && PLACEABLE_PANEL_STATES.includes(m.panel.panelState);
type ConfigFacts = {
  panelId: string;
  inboundRemoteId: string | null;
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
  /** Configs to place now, in panel-id then inbound order. */
  place: InboundPlacementTarget[];
  /**
   * Non-drain members owed a config that cannot take one yet — not placeable,
   * nothing picked (`no_inbound`), or full — retried when they can.
   */
  waiting: string[];
  /** A `pending` Grant has `minHealthyPanels` serving panels with a confirmed config. */
  activate: boolean;
  /** The group's id if one of the Grant's configs already carries it; null means a new one. */
  credentialGroupId: string | null;
};

const byRemoteId = (a: { remoteId: string }, b: { remoteId: string }) => a.remoteId.localeCompare(b.remoteId, 'en', { numeric: true });
const hasRoom = (i: InboundFacts) => i.maxClients === null || i.clients < i.maxClients;

/**
 * The inbounds one member owes this Grant now (network `contract.inbounds.md`).
 * `held`: the inbounds its un-drained configs on the panel are on — `null` for
 * a row placed before F-114-b, which holds the whole panel.
 */
function placementsOn(m: MemberFacts, held: (string | null)[], live: boolean): { targets: InboundFacts[]; owed: boolean } {
  if (held.includes(null)) return { targets: [], owed: false };
  const picked = [...m.panel.inbounds].sort(byRemoteId);
  if (m.panel.inboundPlacement === InboundPlacement.spread) {
    if (held.length > 0) return { targets: [], owed: false };
    const open = picked.filter(hasRoom).sort((a, b) => a.clients - b.clients || byRemoteId(a, b));
    const full = !live && m.panel.maxClients !== null && m.panel.users >= m.panel.maxClients;
    return { targets: full ? [] : open.slice(0, 1), owed: true };
  }
  const missing = picked.filter((i) => !held.includes(i.remoteId));
  // Owed nothing once on every pick; a panel with nothing picked still owes a user it does not hold (`no_inbound`).
  if (missing.length === 0 && held.length > 0) return { targets: [], owed: false };
  // A panel at its cap takes no new user; a user already on it still gets the inbounds it lacks.
  const full = !live && m.panel.maxClients !== null && m.panel.users >= m.panel.maxClients;
  return { targets: full ? [] : missing.filter(hasRoom), owed: true };
}

/**
 * `mirror` over what is true now (network `contract.groups.md` rule 7,
 * `contract.inbounds.md`). Pure, so the same facts give the same plan in any
 * member order.
 *
 * **An inbound with any config of this Grant is covered**, whatever its
 * status: a row still `pending` on a panel that died mid-provisioning is
 * carried by the convergence pass when it returns, and a retired one was a
 * decision (a delete, or a move away) that a refill would undo. Under
 * `spread`, any config covers the whole panel. The partial unique index
 * `config_group_panel_once` (grant, panel, inbound) holds the same line against
 * two concurrent runs. **Except a drained one** (`drainedAt`, F-027-bp): the
 * platform emptied the panel, the user decided nothing, so a member re-added
 * is placed again.
 */
export function planFulfilment(facts: FulfilmentFacts): FulfilmentPlan {
  const kept = facts.configs.filter((c) => !c.drainedAt);
  const members = [...facts.group.members].sort((a, b) => a.panelId.localeCompare(b.panelId));

  const place: InboundPlacementTarget[] = [];
  const waiting: string[] = [];
  for (const m of members) {
    if (m.role === PanelGroupMemberRole.drain) continue;
    const mine = kept.filter((c) => c.panelId === m.panelId);
    const live = mine.some((c) => c.desiredRemote === DesiredRemote.present);
    const { targets, owed } = placementsOn(m, mine.map((c) => c.inboundRemoteId), live);
    if (!owed) continue;
    if (!placeableMember(m) || targets.length === 0) {
      waiting.push(m.panelId);
      continue;
    }
    for (const i of targets) place.push({ panelId: m.panelId, inboundRemoteId: i.remoteId, protocol: i.protocol });
  }

  const serving = new Set(members.filter((m) => SERVING_PANEL_STATES.includes(m.panel.panelState)).map((m) => m.panelId));
  const confirmed = new Set(
    facts.configs
      .filter(
        (c) =>
          c.status === ConfigStatus.active &&
          c.desiredRemote === DesiredRemote.present &&
          c.enforcementState === EnforcementState.complete &&
          serving.has(c.panelId),
      )
      .map((c) => c.panelId),
  ).size;

  return {
    place,
    waiting,
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
 * group gets a config on every non-drain healthy member — one per picked
 * inbound under `all`, one on the emptiest under `spread` (F-114-b) — and
 * activates once `minHealthyPanels` of those panels confirm one.
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
                members: { select: { panelId: true, role: true, panel: { select: MEMBER_PANEL_FIELDS } } },
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
      select: { panelId: true, inboundRemoteId: true, status: true, desiredRemote: true, enforcementState: true, credentialGroupId: true, drainedAt: true },
    });
    const members = await this.withLoad(tx, group.members);
    const plan = planFulfilment({ grantStatus: grant.status, group: { ...group, members }, configs });

    const made = await this.actions.provisionForGroup(tx, {
      grantId,
      placements: plan.place,
      credentialGroupId: plan.credentialGroupId ?? randomUUID(),
      actor: GROUP_FULFILMENT_ACTOR,
    });

    // Conditional on `pending`: an admin's cancel or a refund meanwhile stands.
    // Delivered with its outbox event, so the buyer is told (F-111-d).
    const activated = plan.activate ? await markDelivered(tx, grantId) : false;
    return { placed: made.length, waiting: plan.waiting, activated };
  }

  /**
   * Each member's picked inbounds with how full they are (`contract.inbounds.md`
   * rule 4). The count is every tenant's, so it is read on the cross-tenant
   * pool — **after** a transaction lock on each placeable panel, in panel-id
   * order: a second fulfilment on the same panel (the sweep and the purchase
   * consumer, F-114-i) waits for this one to commit and then counts its rows,
   * so two buyers never take an inbound's last seat together.
   */
  private async withLoad(tx: Prisma.TransactionClient, members: MemberRow[]): Promise<MemberFacts[]> {
    const panelIds = members.filter(placeableMember).map((m) => m.panelId).sort();
    for (const id of panelIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${id}`}))`;
    const load = panelIds.length === 0 ? [] : await this.crossTenant.$queryRaw<{ panelId: string; inboundRemoteId: string | null; total: number; clients: bigint; users: bigint }[]>`
      SELECT c."panelId"::text AS "panelId", c."inboundRemoteId", GROUPING(c."inboundRemoteId")::int AS total,
             count(*) AS clients, count(DISTINCT c."grantId") AS users
        FROM "network"."config" c
       WHERE c."panelId" = ANY(${panelIds}::uuid[]) AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
       GROUP BY GROUPING SETS ((c."panelId", c."inboundRemoteId"), (c."panelId"))`;
    // `total = 1` is the grouping set without the inbound: the panel's own row, its `users`.
    const panelRow = (id: string) => load.find((r) => r.panelId === id && r.total === 1);
    return members.map((m) => ({
      panelId: m.panelId,
      role: m.role,
      panel: {
        ...m.panel,
        users: Number(panelRow(m.panelId)?.users ?? 0),
        inbounds: m.panel.inbounds.flatMap((i) =>
          i.protocol === null
            ? []
            : [{ remoteId: i.remoteId, protocol: i.protocol, maxClients: i.maxClients, clients: Number(load.find((r) => r.panelId === m.panelId && r.total === 0 && r.inboundRemoteId === i.remoteId)?.clients ?? 0) }],
        ),
      },
    }));
  }

  /**
   * One sweep, for `worker-service`'s tick. **The scan names only Grants with
   * a write due** — a placeable member with a picked inbound the Grant is not
   * on and a seat on it (`contract.inbounds.md`), or a `pending` Grant with
   * enough confirmed configs — so a Grant waiting on a
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
                   JOIN "network"."panel_inbound" i ON i."panelId" = p."id"
                        AND i."sold" AND i."enabled" AND i."goneAt" IS NULL AND i."protocol" IS NOT NULL
                  WHERE m."groupId" = pg."id"
                    AND m."role" <> 'drain'
                    AND p."reviewState" IN ('accepted', 'accepted_low_trust')
                    AND p."panelState" = 'healthy'
                    -- not already where this inbound would put the Grant
                    AND NOT EXISTS (SELECT 1 FROM "network"."config" c
                                    WHERE c."grantId" = g."id" AND c."panelId" = m."panelId" AND c."drainedAt" IS NULL
                                      AND (p."inboundPlacement" = 'spread' OR c."inboundRemoteId" IS NULL OR c."inboundRemoteId" = i."remoteId"))
                    -- the inbound has a seat
                    AND (i."maxClients" IS NULL OR i."maxClients" > (
                           SELECT count(*) FROM "network"."config" c
                            WHERE c."panelId" = i."panelId" AND c."inboundRemoteId" = i."remoteId"
                              AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL))
                    -- the panel has room, or already holds this Grant
                    AND (p."maxClients" IS NULL
                         OR EXISTS (SELECT 1 FROM "network"."config" c
                                     WHERE c."grantId" = g."id" AND c."panelId" = p."id"
                                       AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL)
                         OR p."maxClients" > (
                              SELECT count(DISTINCT c."grantId") FROM "network"."config" c
                               WHERE c."panelId" = p."id" AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL)))
            OR (g."status" = 'pending' AND pg."minHealthyPanels" <= (
                 SELECT count(DISTINCT c."panelId") FROM "network"."config" c
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
