import { Injectable, Logger } from '@nestjs/common';
import { ActorType, EvictOrphans, GrantStatus, Prisma } from '@prisma/client';
import { OutboxEventType, platformTenantIdOf, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { deleteGrant } from '../entitlement/delete';
import { ADMIN_FROZEN, freezeGrant, unfreezeGrant } from '../entitlement/freeze';
import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService, ConfigActor } from './config-actions';
import { RemainderCreditService } from './remainder-credit';
import { PANEL_P_NOT_HALTED } from './panel-placeable';

/** Who retired a drained member's configs in `config_action_log`: the drain sweep. */
export const GROUP_DRAIN_ACTOR: ConfigActor = { actorType: ActorType.system, actorId: '00000000-0000-4000-8000-0000000f027c' };

/** How many subscription lifetimes a drain line is left unserved before its config goes. */
export const DRAIN_TTL_MULTIPLE = 2;

/** One live config of the group's Grants on the draining panel. */
export type DrainConfig = {
  configId: string;
  grantId: string;
  tenantId: string;
  grantStatus: GrantStatus;
  /**
   * Since when `/sub` has served another line of this Grant — the earliest
   * `linksCapturedAt` of its configs `/sub` serves that are not on a drain
   * member. Null: none, so `/sub` still serves the drain line.
   */
  replacementSince: Date | null;
};

/** `evicted`: the owner chose "remove now" (F-027-ee) — no wait, no hold. */
export type DrainFacts = { drainingSince: Date; subscriptionTtlSeconds: number; evicted?: boolean; configs: DrainConfig[] };
export type DrainPlan = { retire: DrainConfig[]; held: string[]; removeMember: boolean };

/**
 * Which of a draining member's configs may go now (network `contract.groups.md`
 * rule 14). Pure, so the rule is tested without a database.
 *
 * `/sub` drops a drain line only once its Grant has another line served (rule
 * 13), so a client stops being handed the line at the **later** of the drain
 * and that replacement's capture; after two subscription lifetimes from then,
 * no client still holds a subscription naming it. A Grant `/sub` serves
 * nothing of (not `active`) has no client to cut off, and waits from the drain.
 * An active Grant with no replacement is held: deleting its only line would
 * cut the user off.
 *
 * An evicted member (rule 16) is the owner's call that the panel is broken or
 * gone: everything on it goes now, and the member with it.
 */
export function planDrain(facts: DrainFacts, now: Date): DrainPlan {
  if (facts.evicted) return { retire: [...facts.configs], held: [], removeMember: true };
  const wait = DRAIN_TTL_MULTIPLE * facts.subscriptionTtlSeconds * 1000;
  const since = facts.drainingSince.getTime();
  const retire: DrainConfig[] = [];
  const held = new Set<string>();
  for (const c of facts.configs) {
    let from = since;
    if (c.grantStatus === GrantStatus.active) {
      if (!c.replacementSince) {
        held.add(c.grantId);
        continue;
      }
      from = Math.max(since, c.replacementSince.getTime());
    }
    if (from + wait <= now.getTime()) retire.push(c);
    else held.add(c.grantId);
  }
  return { retire, held: [...held], removeMember: held.size === 0 && since + wait <= now.getTime() };
}

export type DrainDueResult = {
  scanned: number;
  configsRetired: number;
  grantsHeld: number;
  membersRemoved: number;
  failed: number;
  /** Grants an evict left with no line, frozen until a panel joins (F-027-eg). */
  grantsPaused: number;
  /** ... or cancelled with their unused share given back. */
  grantsRefunded: number;
  /** Paused Grants whose group has a healthy member again, unfrozen. */
  grantsResumed: number;
  /** Panels deleted in one step (F-027-eg), archived now that nothing is left on them. */
  panelsArchived: number;
};

/** The `grant_deletion.reason` of a Grant cancelled because its panel was removed. */
export const PANEL_REMOVED = 'panel_removed';

/**
 * What happens to a Grant an evict leaves with no line, in the transaction
 * that retired those lines (F-027-eg); and the way back. A spec replaces them.
 */
export type OrphanHandlers = {
  pause(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<void>;
  refund(tx: Prisma.TransactionClient, grantId: string, at: Date, actorUserId: string): Promise<void>;
  resume(tx: Prisma.TransactionClient, grantId: string, at: Date): Promise<void>;
};

/** Members per sweep. A held member stays due, so this bounds a tick, not the backlog. */
const DRAIN_BATCH_SIZE = 50;

/** Paused Grants unfrozen per sweep; the rest are found again next tick. */
const RESUME_BATCH_SIZE = 200;

type DueMember = {
  groupId: string;
  panelId: string;
  /** The member's tenant; null for a platform group's. */
  tenantId: string | null;
  drainingSince: Date;
  subscriptionTtlSeconds: number;
  evicted: boolean;
  evictOrphans: EvictOrphans | null;
  evictedBy: string | null;
};

/**
 * Draining a panel group member (F-027-bm, catalog §7.3): `role = drain` takes
 * no new Grants (`planFulfilment`), `/sub` stops serving its lines where the
 * Grant has another, and this sweep retires its configs once no client can
 * still hold a subscription naming them, then removes the member.
 *
 * Desired state only, as fulfilment: `ConfigActionsService.drain` retires the
 * row, marked `drainedAt`, and rebalances the Grant, and the convergence pass deletes the
 * client. **No user is cut off at any step** — the wait is `planDrain`'s.
 */
@Injectable()
export class GroupDrainService {
  private readonly logger = new Logger(GroupDrainService.name);

  constructor(
    private readonly actions: ConfigActionsService,
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly remainders: RemainderCreditService,
  ) {}

  /** The wait is judged against this; a spec replaces it. */
  now: () => Date = () => new Date();

  /**
   * Pause is the admin freeze (F-311-h) — clock stopped, never purged, a
   * refund counting time to the freeze — marked `awaitingPanel` so the sweep,
   * not an admin, lifts it. Refund is the admin delete (F-311-m) with the
   * remainder given back, by the owner who evicted.
   */
  orphans: OrphanHandlers = {
    pause: async (tx, grantId, at) => {
      await freezeGrant(tx, grantId, { at });
      await tx.grant.updateMany({ where: { id: grantId, statusReason: ADMIN_FROZEN }, data: { awaitingPanel: true } });
    },
    refund: async (tx, grantId, at, actorUserId) => {
      await deleteGrant(tx, grantId, { at, actorUserId, reason: PANEL_REMOVED, refund: true }, (t, id, clock) => this.remainders.settle(t, { grantId: id, ...clock }));
    },
    resume: async (tx, grantId, at) => {
      await unfreezeGrant(tx, grantId, at);
    },
  };

  /**
   * One sweep, for `worker-service`'s tick. The scan is cross-tenant — a
   * platform group's Grants belong to every tenant — and each retire runs in
   * its Grant's tenant. Safe to run twice (ADR-0027): a retired config is not
   * read again, and a removed member is not due.
   */
  async drainDue(): Promise<DrainDueResult> {
    const grantsResumed = await this.resumeWaiting();
    const due = await this.crossTenant.$queryRaw<DueMember[]>`
      SELECT m."groupId", m."panelId", m."tenantId", m."drainingSince", pg."subscriptionTtlSeconds", m."evictedAt" IS NOT NULL AS "evicted",
             m."evictOrphans", m."evictedBy"
        FROM "network"."panel_group_member" m
        JOIN "network"."panel_group" pg ON pg."id" = m."groupId"
       WHERE m."role" = 'drain'
         AND (m."evictedAt" IS NOT NULL OR m."drainingSince" + make_interval(secs => ${DRAIN_TTL_MULTIPLE} * pg."subscriptionTtlSeconds") <= now() AT TIME ZONE 'UTC')
       ORDER BY m."evictedAt" ASC NULLS LAST, m."drainingSince" ASC
       LIMIT ${DRAIN_BATCH_SIZE}`;

    const result: DrainDueResult = { scanned: due.length, configsRetired: 0, grantsHeld: 0, membersRemoved: 0, failed: 0, grantsPaused: 0, grantsRefunded: 0, grantsResumed, panelsArchived: 0 };
    for (const member of due) {
      const configs = await drainConfigs(this.crossTenant, member);
      const plan = planDrain({ drainingSince: member.drainingSince, subscriptionTtlSeconds: member.subscriptionTtlSeconds, evicted: member.evicted, configs }, this.now());
      result.grantsHeld += plan.held.length;

      const retiredBefore = result.configsRetired;
      // An evict's orphans: each Grant's lines go with its pause or refund, in one transaction.
      const orphans = member.evicted && member.evictOrphans ? orphanLines(plan.retire) : new Map<string, DrainConfig[]>();
      let failed = 0;
      for (const [grantId, lines] of orphans) {
        try {
          await this.settleOrphan(member, grantId, lines);
          result.configsRetired += lines.length;
          if (member.evictOrphans === EvictOrphans.refund) result.grantsRefunded += 1;
          else result.grantsPaused += 1;
        } catch (e) {
          failed += 1;
          this.logger.warn(`${member.evictOrphans} of Grant ${grantId} evicted from panel ${member.panelId} failed: ${errorLine(e)}`);
        }
      }
      for (const c of plan.retire.filter((c) => !orphans.has(c.grantId))) {
        try {
          await runWithTenant({ id: c.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.actions.drain(tx, { configId: c.configId, actor: GROUP_DRAIN_ACTOR })));
          result.configsRetired += 1;
        } catch (e) {
          // One config's failure — a user's own retire or move meanwhile — is its
          // own; the member stays and is named again next tick.
          failed += 1;
          this.logger.warn(`drain of config ${c.configId} on panel ${member.panelId} failed: ${errorLine(e)}`);
        }
      }
      result.failed += failed;
      const removed = plan.removeMember && failed === 0 ? await this.removeMember(member) : 0;
      result.membersRemoved += removed;
      // The open systems page re-reads once per member per pass (RT-1-f), not once per
      // config: an evict retires hundreds. A removal carries the row; a pass that only
      // retired writes it after its retires, each of which was its Grant's own transaction.
      if (removed === 0 && result.configsRetired > retiredBefore) await announceDrained(this.crossTenant, member);
    }
    result.panelsArchived = await this.archiveRemoved();
    if (result.configsRetired > 0 || result.membersRemoved > 0) {
      this.logger.log(
        `retired ${result.configsRetired} config(s), removed ${result.membersRemoved} drained member(s); ` +
          `${result.grantsPaused} Grant(s) paused, ${result.grantsRefunded} refunded for want of a panel`,
      );
    }
    return result;
  }

  /**
   * A panel deleted in one step is archived once it is in no group and has no
   * live config, and its clients are gone from it — `remoteId` cleared by the
   * convergence pass, so no user keeps a working line on a panel nobody
   * watches any more — or an hour after the ask, for a dead panel that will
   * never confirm. One statement; a panel not ready is found again next tick.
   */
  private archiveRemoved(): Promise<number> {
    return this.crossTenant.$executeRaw`UPDATE "network"."panel" p
         SET "retiredAt" = now() AT TIME ZONE 'UTC', "removeRequestedAt" = NULL
       WHERE p."removeRequestedAt" IS NOT NULL AND p."retiredAt" IS NULL
         AND NOT EXISTS (SELECT 1 FROM "network"."panel_group_member" m WHERE m."panelId" = p."id")
         AND NOT EXISTS (SELECT 1 FROM "network"."config" c WHERE c."panelId" = p."id" AND c."status" <> 'retired')
         AND (p."removeRequestedAt" <= now() AT TIME ZONE 'UTC' - interval '1 hour'
              OR NOT EXISTS (SELECT 1 FROM "network"."config" c WHERE c."panelId" = p."id" AND c."remoteId" IS NOT NULL))`;
  }

  private settleOrphan(member: DueMember, grantId: string, lines: DrainConfig[]) {
    const at = this.now();
    return runWithTenant({ id: lines[0].tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        for (const c of lines) await this.actions.drain(tx, { configId: c.configId, actor: GROUP_DRAIN_ACTOR });
        if (member.evictOrphans === EvictOrphans.refund) await this.orphans.refund(tx, grantId, at, member.evictedBy ?? GROUP_DRAIN_ACTOR.actorId);
        else await this.orphans.pause(tx, grantId, at);
      }),
    );
  }

  /**
   * Paused Grants (`awaitingPanel`) whose group has a member fulfilment can
   * place on — not `drain`, not retired, accepted, healthy, not halted
   * (F-027-fe) — are unfrozen: the
   * clock runs again from now, `endsAt` moved by the pause, and fulfil-due
   * places their configs on its next pass. Health is asked here, unlike
   * `deliverableGroupIds`: the clock must not restart on a panel that is down.
   */
  private async resumeWaiting(): Promise<number> {
    const waiting = await this.crossTenant.$queryRaw<Array<{ id: string; tenantId: string }>>`
      SELECT g."id", g."tenantId"
        FROM "entitlement"."grant" g
       WHERE g."awaitingPanel"
         AND g."status" = 'suspended' AND g."statusReason" = ${ADMIN_FROZEN}
         AND EXISTS (SELECT 1 FROM "network"."panel_group_member" m
                       JOIN "network"."panel" p ON p."id" = m."panelId"
                      WHERE m."groupId" = g."panelGroupId" AND m."role" <> 'drain'
                        AND p."retiredAt" IS NULL AND p."reviewState" IN ('accepted', 'accepted_low_trust')
                        AND p."panelState" = 'healthy'
                        AND ${PANEL_P_NOT_HALTED})
       ORDER BY g."suspendedAt" ASC
       LIMIT ${RESUME_BATCH_SIZE}`;
    let resumed = 0;
    for (const g of waiting) {
      try {
        await runWithTenant({ id: g.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.orphans.resume(tx, g.id, this.now())));
        resumed += 1;
      } catch (e) {
        // An admin's own unfreeze or delete meanwhile: nothing left to resume.
        this.logger.warn(`resume of Grant ${g.id} failed: ${errorLine(e)}`);
      }
    }
    if (resumed > 0) this.logger.log(`resumed ${resumed} Grant(s) whose group has a panel again`);
    return resumed;
  }

  /**
   * Conditional on what made it removable: still `drain` (an un-drain
   * meanwhile stands) and no live config of the group's Grants on the panel (a
   * placement meanwhile keeps it). Cross-tenant: a platform group's member is
   * shared-read to `txnet_app`.
   */
  private removeMember(member: DueMember): Promise<number> {
    return this.crossTenant.$transaction(async (tx) => {
      const removed = await tx.$executeRaw`DELETE FROM "network"."panel_group_member" m
       WHERE m."groupId" = ${member.groupId}::uuid AND m."panelId" = ${member.panelId}::uuid
         AND m."role" = 'drain'
         AND NOT EXISTS (
               SELECT 1 FROM "network"."config" c
                 JOIN "entitlement"."grant" g ON g."id" = c."grantId"
                WHERE c."panelId" = m."panelId" AND g."panelGroupId" = m."groupId" AND c."status" <> 'retired')`;
      if (removed > 0) await announceDrained(tx, member);
      return removed;
    });
  }
}

/**
 * A drain sweep moved a member (RT-1-f): the member tenant's open systems page
 * re-reads its groups — the platform's for a platform group. Body is ids only
 * (ADR-0121 point 3).
 */
async function announceDrained(db: Pick<Prisma.TransactionClient, 'outboxEvent' | 'tenant'>, member: Pick<DueMember, 'groupId' | 'panelId' | 'tenantId'>): Promise<void> {
  const tenantId = member.tenantId ?? (await platformTenantIdOf(db));
  await db.outboxEvent.create({
    data: { aggregate: 'network.panel_group_member', aggregateId: member.panelId, type: OutboxEventType.PANEL_DRAINED, payload: { tenantId, panelId: member.panelId, groupId: member.groupId } },
  });
}

/**
 * Every unretired config of the group's Grants on the member's panel, with its
 * Grant's replacement: what the sweep plans from, and what the systems routes
 * count for a held drain and a "remove now" (F-027-ee) — one reading of
 * "another line is served" for all three.
 */
export function drainConfigs(db: Pick<CrossTenantPrismaService, '$queryRaw'>, member: { groupId: string; panelId: string }): Promise<DrainConfig[]> {
  return db.$queryRaw<DrainConfig[]>`
    SELECT c."id" AS "configId", c."grantId", g."tenantId", g."status" AS "grantStatus",
           (SELECT min(r."linksCapturedAt")
              FROM "network"."config" r
              JOIN "network"."panel" p ON p."id" = r."panelId"
             WHERE r."grantId" = g."id" AND r."panelId" <> c."panelId"
               AND r."status" = 'active' AND r."desiredRemote" = 'present' AND r."linksUuid" = r."uuid"
               AND p."panelState" IN ('healthy', 'degraded', 'throttled_or_blocked')
               AND NOT EXISTS (SELECT 1 FROM "network"."panel_group_member" d
                                WHERE d."groupId" = g."panelGroupId" AND d."panelId" = r."panelId" AND d."role" = 'drain')
           ) AS "replacementSince"
      FROM "network"."config" c
      JOIN "entitlement"."grant" g ON g."id" = c."grantId"
     WHERE c."panelId" = ${member.panelId}::uuid
       AND g."panelGroupId" = ${member.groupId}::uuid
       AND c."status" <> 'retired'
     ORDER BY c."id"`;
}

/** An evict's orphans among the configs it retires: each sole-line active Grant with its lines here. */
function orphanLines(configs: DrainConfig[]): Map<string, DrainConfig[]> {
  const out = new Map<string, DrainConfig[]>();
  for (const c of configs) {
    if (c.grantStatus !== GrantStatus.active || c.replacementSince) continue;
    out.set(c.grantId, [...(out.get(c.grantId) ?? []), c]);
  }
  return out;
}

/** The active Grants with a line here and none served elsewhere: who has no line once these configs go. */
export function soleLineGrants(configs: DrainConfig[]): number {
  return new Set(configs.filter((c) => c.grantStatus === GrantStatus.active && !c.replacementSince).map((c) => c.grantId)).size;
}
