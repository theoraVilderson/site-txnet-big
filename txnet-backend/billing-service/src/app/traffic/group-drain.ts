import { Injectable, Logger } from '@nestjs/common';
import { ActorType, GrantStatus } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService, ConfigActor } from './config-actions';

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

export type DrainFacts = { drainingSince: Date; subscriptionTtlSeconds: number; configs: DrainConfig[] };
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
 */
export function planDrain(facts: DrainFacts, now: Date): DrainPlan {
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

export type DrainDueResult = { scanned: number; configsRetired: number; grantsHeld: number; membersRemoved: number; failed: number };

/** Members per sweep. A held member stays due, so this bounds a tick, not the backlog. */
const DRAIN_BATCH_SIZE = 50;

type DueMember = { groupId: string; panelId: string; drainingSince: Date; subscriptionTtlSeconds: number };

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
  ) {}

  /** The wait is judged against this; a spec replaces it. */
  now: () => Date = () => new Date();

  /**
   * One sweep, for `worker-service`'s tick. The scan is cross-tenant — a
   * platform group's Grants belong to every tenant — and each retire runs in
   * its Grant's tenant. Safe to run twice (ADR-0027): a retired config is not
   * read again, and a removed member is not due.
   */
  async drainDue(): Promise<DrainDueResult> {
    const due = await this.crossTenant.$queryRaw<DueMember[]>`
      SELECT m."groupId", m."panelId", m."drainingSince", pg."subscriptionTtlSeconds"
        FROM "network"."panel_group_member" m
        JOIN "network"."panel_group" pg ON pg."id" = m."groupId"
       WHERE m."role" = 'drain'
         AND m."drainingSince" + make_interval(secs => ${DRAIN_TTL_MULTIPLE} * pg."subscriptionTtlSeconds") <= now() AT TIME ZONE 'UTC'
       ORDER BY m."drainingSince" ASC
       LIMIT ${DRAIN_BATCH_SIZE}`;

    const result: DrainDueResult = { scanned: due.length, configsRetired: 0, grantsHeld: 0, membersRemoved: 0, failed: 0 };
    for (const member of due) {
      const configs = await this.liveConfigs(member);
      const plan = planDrain({ drainingSince: member.drainingSince, subscriptionTtlSeconds: member.subscriptionTtlSeconds, configs }, this.now());
      result.grantsHeld += plan.held.length;

      let failed = 0;
      for (const c of plan.retire) {
        try {
          await runWithTenant({ id: c.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.actions.drain(tx, { configId: c.configId, actor: GROUP_DRAIN_ACTOR })));
          result.configsRetired += 1;
        } catch (e) {
          // One config's failure — a user's own retire or move meanwhile — is its
          // own; the member stays and is named again next tick.
          failed += 1;
          this.logger.warn(`drain of config ${c.configId} on panel ${member.panelId} failed: ${(e as Error).message}`);
        }
      }
      result.failed += failed;
      if (plan.removeMember && failed === 0) result.membersRemoved += await this.removeMember(member);
    }
    if (result.configsRetired > 0 || result.membersRemoved > 0) {
      this.logger.log(`retired ${result.configsRetired} config(s), removed ${result.membersRemoved} drained member(s)`);
    }
    return result;
  }

  /** Every unretired config of the group's Grants on the member's panel, with its Grant's replacement. */
  private liveConfigs(member: DueMember): Promise<DrainConfig[]> {
    return this.crossTenant.$queryRaw<DrainConfig[]>`
      SELECT c."id" AS "configId", c."grantId", g."tenantId", g."status" AS "grantStatus",
             (SELECT min(r."linksCapturedAt")
                FROM "network"."config" r
                JOIN "network"."panel" p ON p."id" = r."panelId"
               WHERE r."grantId" = g."id" AND r."panelId" <> c."panelId"
                 AND r."status" = 'active' AND r."desiredRemote" = 'present' AND r."linksUuid" = r."uuid"
                 AND p."panelState" IN ('healthy', 'degraded', 'throttled_or_blocked')
                 AND NOT EXISTS (SELECT 1 FROM "network"."panel_group_member" d
                                  WHERE d."groupId" = v."panelGroupId" AND d."panelId" = r."panelId" AND d."role" = 'drain')
             ) AS "replacementSince"
        FROM "network"."config" c
        JOIN "entitlement"."grant" g ON g."id" = c."grantId"
        JOIN "catalog"."product_variant" v ON v."id" = g."variantId"
       WHERE c."panelId" = ${member.panelId}::uuid
         AND v."panelGroupId" = ${member.groupId}::uuid
         AND c."status" <> 'retired'
       ORDER BY c."id"`;
  }

  /**
   * Conditional on what made it removable: still `drain` (an un-drain
   * meanwhile stands) and no live config of the group's Grants on the panel (a
   * placement meanwhile keeps it). Cross-tenant: a platform group's member is
   * shared-read to `txnet_app`.
   */
  private removeMember(member: DueMember): Promise<number> {
    return this.crossTenant.$executeRaw`DELETE FROM "network"."panel_group_member" m
       WHERE m."groupId" = ${member.groupId}::uuid AND m."panelId" = ${member.panelId}::uuid
         AND m."role" = 'drain'
         AND NOT EXISTS (
               SELECT 1 FROM "network"."config" c
                 JOIN "entitlement"."grant" g ON g."id" = c."grantId"
                 JOIN "catalog"."product_variant" v ON v."id" = g."variantId"
                WHERE c."panelId" = m."panelId" AND v."panelGroupId" = m."groupId" AND c."status" <> 'retired')`;
  }
}
