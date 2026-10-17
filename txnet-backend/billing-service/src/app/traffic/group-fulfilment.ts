import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ActorType, GrantStatus, InboundAudience, PanelGroupMemberRole, PanelGroupStrategy, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { markDelivered } from '../entitlement/delivered';
import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService, ConfigActor } from './config-actions';
import { MemberFacts, placementSettings, planFulfilment } from './group-plan';
import { HALTING_DRIFT_EVENT, PANEL_P_NOT_HALTED, PLACEABLE_PANEL_FIELDS, PLACEABLE_REVIEW_STATES, placeableMember } from './panel-placeable';
import { PLATFORM_SELLING_DEFAULTS, sellingInbounds } from './selling-settings';

/**
 * Who placed a group's configs in `config_action_log`: the fulfilment job, not
 * the user whose Grant it is. One fixed id, so the log reads as one actor.
 */
export const GROUP_FULFILMENT_ACTOR: ConfigActor = { actorType: ActorType.system, actorId: '00000000-0000-4000-8000-0000000f027b' };

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

/** An inbound a buyer may be placed on (network `contract.inbounds.md` rule 2), before who sells it. */
const PLACEABLE_INBOUND = { enabled: true, goneAt: null, protocol: { not: null } } satisfies Prisma.PanelInboundWhereInput;

/** What every group of the panel sells: `every_group`, picked and placeable (F-027-ep). */
const EVERY_GROUP_INBOUND = { sold: true, ...PLACEABLE_INBOUND, audience: InboundAudience.every_group } satisfies Prisma.PanelInboundWhereInput;

/**
 * A member's panel as fulfilment reads it: its health, how it places, its cap,
 * and its `every_group` inbounds (network `contract.inbounds.md` rules 2, 3a) —
 * the unpicked, disabled, gone and listed ones are never loaded here.
 */
const MEMBER_PANEL_FIELDS = {
  ...PLACEABLE_PANEL_FIELDS,
  inboundPlacement: true,
  maxClients: true,
  inboundsPerBuyer: true,
  inbounds: { where: EVERY_GROUP_INBOUND, select: { remoteId: true, protocol: true, maxClients: true } },
} satisfies Prisma.PanelSelect;

/**
 * The member's own layer of the selling settings (F-027-cg; null = the
 * panel's) and its listed inbounds, sold beside the every-group ones
 * (F-027-ep), each with the group's share of it (F-027-eq).
 */
const MEMBER_FIELDS = {
  panelId: true,
  role: true,
  inboundPlacement: true,
  maxClients: true,
  inboundsPerBuyer: true,
  inbounds: { select: { maxClients: true, inbound: { select: { remoteId: true, protocol: true, maxClients: true, enabled: true, goneAt: true } } } },
  panel: { select: MEMBER_PANEL_FIELDS },
} satisfies Prisma.PanelGroupMemberSelect;

type MemberRow = Prisma.PanelGroupMemberGetPayload<{ select: typeof MEMBER_FIELDS }>;

/**
 * The groups among `groupIds` that can deliver a new sale (F-111-i): at least
 * `minHealthyPanels` members that could ever place one — not `drain`, not
 * retired, accepted, selling one inbound: an assigned one, or with none
 * assigned one of the pool (F-027-ch), not halted (F-027-fe). Health is left
 * out on purpose: a panel down for a minute is waited for by delivery's clock,
 * and must not take the variant out of the shop and put it back each minute.
 * A halt is not a minute: it lasts until an admin acknowledges it.
 */
export async function deliverableGroupIds(tx: Prisma.TransactionClient, groupIds: readonly string[]): Promise<Set<string>> {
  if (groupIds.length === 0) return new Set();
  const groups = await tx.panelGroup.findMany({
    where: { id: { in: [...new Set(groupIds)] } },
    select: {
      id: true,
      minHealthyPanels: true,
      members: {
        where: {
          role: { not: PanelGroupMemberRole.drain },
          panel: { retiredAt: null, reviewState: { in: [...PLACEABLE_REVIEW_STATES] }, driftEvents: { none: HALTING_DRIFT_EVENT } },
          OR: [
            { inbounds: { some: { inbound: PLACEABLE_INBOUND } } },
            { panel: { inbounds: { some: EVERY_GROUP_INBOUND } } },
          ],
        },
        select: { panelId: true },
      },
    },
  });
  return new Set(groups.filter((g) => g.members.length >= Math.max(1, g.minHealthyPanels)).map((g) => g.id));
}

export type Fulfilment = { placed: number; waiting: string[]; activated: boolean };
/** What one Grant's check found (F-111-n): not `pending` any more, still short of its panels, or activated now. */
export type FulfilNowOutcome = 'skipped' | 'waiting' | 'activated';
export type FulfilDueResult = { scanned: number; configsPlaced: number; grantsActivated: number; grantsFailed: number };

/** Grants per sweep. The scan names only Grants with a write due, so a batch drains. */
const FULFIL_BATCH_SIZE = 200;

/**
 * Group fulfilment (F-027-bl, catalog §7.3): a Grant of a variant with a panel
 * group gets a config on every non-drain healthy member — one per picked
 * inbound under `all`, one on the emptiest under `spread` (F-114-b), K by the
 * Grant's rendezvous hash under `hrw` (F-027-di) — and
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
        panelGroupId: true,
        // The Grant's own group, never its variant's (F-027-er, ADR-0127 decision 4).
        panelGroup: {
          select: {
            strategy: true,
            minHealthyPanels: true,
            members: { select: MEMBER_FIELDS },
          },
        },
      },
    });
    if (!grant) throw new GroupFulfilmentRefused('grant_not_found', grantId);
    if (grant.status !== GrantStatus.pending && grant.status !== GrantStatus.active) throw new GroupFulfilmentRefused('grant_not_fulfillable', grant.status);
    const group = grant.panelGroup;
    if (!group || !grant.panelGroupId) throw new GroupFulfilmentRefused('no_panel_group', grantId);
    // `priority` and `weighted` were declared with no fulfilment behind them
    // (contract.groups.md rule 7): refused, never placed as `mirror`.
    if (group.strategy !== PanelGroupStrategy.mirror) throw new GroupFulfilmentRefused('strategy_not_built', group.strategy);

    const configs = await tx.config.findMany({
      where: { grantId },
      select: { panelId: true, inboundRemoteId: true, status: true, desiredRemote: true, enforcementState: true, credentialGroupId: true, drainedAt: true },
    });
    const members = await this.withLoad(tx, grant.panelGroupId, group.members);
    const plan = planFulfilment({ grantId, grantStatus: grant.status, group: { ...group, members }, configs });

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
   * rule 5): every config and Grant, and `groupId`'s own among them, for the
   * group's shares (F-027-eq). The count is every tenant's, so it is read on the cross-tenant
   * pool — **after** a transaction lock on each placeable panel, in panel-id
   * order: a second fulfilment on the same panel (the sweep and the purchase
   * consumer, F-114-i) waits for this one to commit and then counts its rows,
   * so two buyers never take an inbound's last seat together.
   */
  private async withLoad(tx: Prisma.TransactionClient, groupId: string, members: MemberRow[]): Promise<MemberFacts[]> {
    const panelIds = members.filter(placeableMember).map((m) => m.panelId).sort();
    for (const id of panelIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${id}`}))`;
    type Load = { panelId: string; inboundRemoteId: string | null; total: number; clients: bigint; users: bigint; groupClients: bigint; groupUsers: bigint };
    const load = panelIds.length === 0 ? [] : await this.crossTenant.$queryRaw<Load[]>`
      SELECT c."panelId"::text AS "panelId", c."inboundRemoteId", GROUPING(c."inboundRemoteId")::int AS total,
             count(*) AS clients, count(DISTINCT c."grantId") AS users,
             count(*) FILTER (WHERE g."panelGroupId" = ${groupId}::uuid) AS "groupClients",
             count(DISTINCT c."grantId") FILTER (WHERE g."panelGroupId" = ${groupId}::uuid) AS "groupUsers"
        FROM "network"."config" c
        LEFT JOIN "entitlement"."grant" g ON g."id" = c."grantId"
       WHERE c."panelId" = ANY(${panelIds}::uuid[]) AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
       GROUP BY GROUPING SETS ((c."panelId", c."inboundRemoteId"), (c."panelId"))`;
    // `total = 1` is the grouping set without the inbound: the panel's own row, its `users`.
    const panelRow = (id: string) => load.find((r) => r.panelId === id && r.total === 1);
    return members.map((m) => {
      const inboundRow = (remoteId: string) => load.find((r) => r.panelId === m.panelId && r.total === 0 && r.inboundRemoteId === remoteId);
      return {
        panelId: m.panelId,
        role: m.role,
        panel: {
          ...m.panel,
          ...placementSettings(m),
          users: Number(panelRow(m.panelId)?.users ?? 0),
          groupUsers: Number(panelRow(m.panelId)?.groupUsers ?? 0),
          // The membership's listed inbounds plus the every-group ones (F-027-ep).
          inbounds: sellingInbounds(m).map((i) => ({
            ...i,
            clients: Number(inboundRow(i.remoteId)?.clients ?? 0),
            groupClients: Number(inboundRow(i.remoteId)?.groupClients ?? 0),
          })),
        },
      };
    });
  }

  /**
   * One Grant, the moment a config of it is confirmed (F-111-n): network's
   * `network.config.confirmed` -> worker-service -> here. The same `fulfil`
   * the sweep runs, so it activates only on `minHealthyPanels` confirmed
   * configs (rule 10); only a `pending` Grant is looked at, so a repeat, a
   * cancel or a gift answers `skipped` and writes nothing. The sweep stays
   * behind it for an event that is lost.
   */
  async fulfilNow(grantId: string): Promise<FulfilNowOutcome> {
    const grant = await this.crossTenant.grant.findFirst({ where: { id: grantId, status: GrantStatus.pending }, select: { id: true, tenantId: true } });
    if (!grant) return 'skipped';
    const done = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.fulfil(tx, grant.id)));
    return done.activated ? 'activated' : 'waiting';
  }

  /**
   * One sweep, for `worker-service`'s tick. **The scan names only Grants with
   * a write due** — a placeable member with an inbound it sells (listed to it, or
   * every group's) the Grant is not on and a seat on it (`contract.inbounds.md`), or a `pending` Grant with
   * enough confirmed configs — so a Grant waiting on a
   * down panel does not occupy a batch slot, and a second call finds nothing
   * (ADR-0027). The scan is cross-tenant; each write runs in its tenant.
   */
  async fulfilDue(): Promise<FulfilDueResult> {
    const due = await this.crossTenant.$queryRaw<{ id: string; tenantId: string }[]>`
      SELECT g."id", g."tenantId"
        FROM "entitlement"."grant" g
        JOIN "network"."panel_group" pg ON pg."id" = g."panelGroupId"
       WHERE g."status" IN ('pending', 'active')
         AND pg."strategy" = 'mirror'
         AND (
               EXISTS (
                 SELECT 1 FROM "network"."panel_group_member" m
                   JOIN "network"."panel" p ON p."id" = m."panelId"
                   JOIN "network"."panel_inbound" i ON i."panelId" = p."id"
                        AND i."enabled" AND i."goneAt" IS NULL AND i."protocol" IS NOT NULL
                        -- sold by this group: listed to its membership, or every group's while picked (F-027-ep)
                        AND (EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a
                                      WHERE a."groupId" = m."groupId" AND a."panelId" = m."panelId" AND a."inboundRemoteId" = i."remoteId")
                             OR (i."sold" AND i."audience" = 'every_group'))
                  WHERE m."groupId" = pg."id"
                    AND m."role" <> 'drain'
                    AND p."reviewState" IN ('accepted', 'accepted_low_trust')
                    AND p."panelState" = 'healthy'
                    AND ${PANEL_P_NOT_HALTED}
                    -- not already where this inbound would put the Grant
                    AND NOT EXISTS (SELECT 1 FROM "network"."config" c
                                    WHERE c."grantId" = g."id" AND c."panelId" = m."panelId" AND c."drainedAt" IS NULL
                                      AND (COALESCE(m."inboundPlacement", p."inboundPlacement", ${PLATFORM_SELLING_DEFAULTS.inboundPlacement}::"network"."InboundPlacement") = 'spread'
                                           OR c."inboundRemoteId" IS NULL OR c."inboundRemoteId" = i."remoteId"))
                    -- under hrw, fewer than K un-drained configs of the Grant on the panel (F-027-di)
                    AND (COALESCE(m."inboundPlacement", p."inboundPlacement", ${PLATFORM_SELLING_DEFAULTS.inboundPlacement}::"network"."InboundPlacement") <> 'hrw'
                         OR COALESCE(m."inboundsPerBuyer", p."inboundsPerBuyer", ${PLATFORM_SELLING_DEFAULTS.inboundsPerBuyer}) > (
                              SELECT count(*) FROM "network"."config" c
                               WHERE c."grantId" = g."id" AND c."panelId" = m."panelId" AND c."drainedAt" IS NULL))
                    -- the inbound has a seat
                    AND (i."maxClients" IS NULL OR i."maxClients" > (
                           SELECT count(*) FROM "network"."config" c
                            WHERE c."panelId" = i."panelId" AND c."inboundRemoteId" = i."remoteId"
                              AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL))
                    -- and the group's share of it, over the group's own (F-027-eq)
                    AND NOT EXISTS (SELECT 1 FROM "network"."panel_group_member_inbound" a
                                     WHERE a."groupId" = m."groupId" AND a."panelId" = m."panelId" AND a."inboundRemoteId" = i."remoteId"
                                       AND a."maxClients" <= (
                                         SELECT count(*) FROM "network"."config" c
                                           JOIN "entitlement"."grant" cg ON cg."id" = c."grantId" AND cg."panelGroupId" = m."groupId"
                                          WHERE c."panelId" = i."panelId" AND c."inboundRemoteId" = i."remoteId"
                                            AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL))
                    -- the panel has room — its own cap over every Grant (the platform's is none), the
                    -- member's over the group's (F-027-eq) — or already holds this Grant
                    AND (EXISTS (SELECT 1 FROM "network"."config" c
                                  WHERE c."grantId" = g."id" AND c."panelId" = p."id"
                                    AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL)
                         OR ((p."maxClients" IS NULL OR p."maxClients" > (
                                SELECT count(DISTINCT c."grantId") FROM "network"."config" c
                                 WHERE c."panelId" = p."id" AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL))
                             AND (m."maxClients" IS NULL OR m."maxClients" > (
                                SELECT count(DISTINCT c."grantId") FROM "network"."config" c
                                  JOIN "entitlement"."grant" cg ON cg."id" = c."grantId" AND cg."panelGroupId" = m."groupId"
                                 WHERE c."panelId" = p."id" AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL)))))
            OR (g."status" = 'pending' AND pg."minHealthyPanels" <= (
                 SELECT count(DISTINCT c."panelId") FROM "network"."config" c
                   JOIN "network"."panel" p ON p."id" = c."panelId"
                   JOIN "network"."panel_group_member" m ON m."groupId" = pg."id" AND m."panelId" = c."panelId"
                  WHERE c."grantId" = g."id"
                    AND c."status" = 'active' AND c."desiredRemote" = 'present' AND c."enforcementState" = 'complete'
                    AND p."panelState" IN ('healthy', 'degraded', 'throttled_or_blocked')
                    AND ${PANEL_P_NOT_HALTED}))
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
        this.logger.warn(`group fulfilment of grant ${grant.id} failed: ${errorLine(e)}`);
      }
    }
    if (result.configsPlaced > 0 || result.grantsActivated > 0) {
      this.logger.log(`placed ${result.configsPlaced} config(s), activated ${result.grantsActivated} of ${due.length} Grant(s)`);
    }
    return result;
  }
}
