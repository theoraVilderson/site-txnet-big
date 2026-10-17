import { Injectable } from '@nestjs/common';
import { ActorType, ConfigMoveJob, ConfigStatus, DesiredRemote, EvictOrphans, GrantStatus, InboundAudience, Prisma } from '@prisma/client';

import { auditedConfigAct } from '../grant-audit/grant-audit';
import { ConfigActionsService } from './config-actions';
import { GroupDrainService } from './group-drain';
import { GroupFulfilmentRefused, GroupFulfilmentService } from './group-fulfilment';

/** What a release job names (F-027-es): one inbound of one panel, and the groups that stop selling it. */
export type ReleaseSource = { panelId: string; remoteId: string; groupIds: string[] };

/** A move job's own refusal of one config, beside `ConfigActions`' (F-311-ad, F-027-es): kept as the item's outcome at once. */
export class MoveItemRefused extends Error {
  constructor(readonly reason: 'already_on_target' | 'no_target') {
    super(reason);
    this.name = 'MoveItemRefused';
  }
}

/** A config fulfilment and `/sub` still count: placed, not retired, not emptied by the platform. */
const LIVE_CONFIG = { status: { not: ConfigStatus.retired }, desiredRemote: DesiredRemote.present, drainedAt: null } satisfies Prisma.ConfigWhereInput;

/**
 * The live configs of the released groups' Grants on the inbound, as one
 * release job's items (F-027-es): every tenant's — a platform group's Grants
 * are its resellers' users' too — each item carrying its config's tenant, so
 * the drain moves it in that tenant. A config that names no inbound yet (network
 * `contract.inbounds.md` rule 7) is left out: it may be on another one.
 * On the cross-tenant pool.
 */
export function insertReleaseSelection(tx: Prisma.TransactionClient, jobId: string, source: ReleaseSource, limit: number): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO "network"."config_move_job_item" ("jobId", "tenantId", "configId")
    SELECT ${jobId}::uuid, c."tenantId", c."id"
      FROM "network"."config" c
      JOIN "entitlement"."grant" g ON g."id" = c."grantId"
     WHERE c."panelId" = ${source.panelId}::uuid AND c."inboundRemoteId" = ${source.remoteId}
       AND g."panelGroupId" = ANY(${source.groupIds}::uuid[])
       AND c."status" <> 'retired' AND c."desiredRemote" = 'present' AND c."drainedAt" IS NULL
     ORDER BY c."id"
     LIMIT ${limit}`;
}

/**
 * Applies a release when its job ends (ADR-0127 decision 6: the listing goes
 * only then): the released groups stop selling the inbound — an `every_group`
 * one becomes `listed` to every other member, a `listed` one loses their
 * listings — and the job's hold on new placements goes. Under the panel's
 * fulfilment lock, on the cross-tenant pool (a platform group's rows carry
 * `tenantId` null). The audience is written before a listing, as the triggers require.
 */
export async function applyRelease(tx: Prisma.TransactionClient, job: Pick<ConfigMoveJob, 'id' | 'source'>): Promise<void> {
  const { panelId, remoteId, groupIds } = job.source as ReleaseSource;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${panelId}`}))`;
  const inbound = await tx.panelInbound.findUnique({ where: { panelId_remoteId: { panelId, remoteId } }, select: { audience: true } });
  if (inbound?.audience === InboundAudience.every_group) {
    const members = await tx.panelGroupMember.findMany({ where: { panelId, groupId: { notIn: groupIds } }, select: { groupId: true } });
    await tx.panelInbound.updateMany({ where: { panelId, remoteId }, data: { audience: InboundAudience.listed } });
    if (members.length > 0) await tx.panelGroupMemberInbound.createMany({ data: members.map((m) => ({ groupId: m.groupId, panelId, inboundRemoteId: remoteId })), skipDuplicates: true });
  } else if (inbound) {
    await tx.panelGroupMemberInbound.deleteMany({ where: { panelId, inboundRemoteId: remoteId, groupId: { in: groupIds } } });
  }
  await tx.inboundRelease.deleteMany({ where: { jobId: job.id } });
}

/**
 * The two ways out of a release (F-027-es, ADR-0127 decision 6), one config
 * at a time inside the drain's transaction, in the config's tenant, as the
 * job's admin, each audited on the config with the job's reason:
 *
 * - **move**: the config is drained (`ConfigActions.drain`) and the Grant's
 *   group is fulfilled at once — the release's hold keeps it off this inbound,
 *   so it lands on its next placement. A Grant left with no live line is
 *   `no_target` and rolls back: reported, and left serving.
 * - **empty**: the config is retired there; an active Grant left with no live
 *   line follows the job's `orphans`, `pause` or `refund`, as an evict does (F-027-eg).
 */
@Injectable()
export class InboundReleaseActs {
  constructor(
    private readonly actions: ConfigActionsService,
    private readonly fulfilment: GroupFulfilmentService,
    private readonly drains: GroupDrainService,
  ) {}

  async move(tx: Prisma.TransactionClient, job: ConfigMoveJob, configId: string): Promise<null> {
    const grantId = await this.audited(tx, job, configId, 'config_move', () => this.actions.drain(tx, { configId, actor: actorOf(job) }));
    try {
      await this.fulfilment.fulfil(tx, grantId);
    } catch (e) {
      // A Grant no longer carrying service has no next placement to want.
      if (!(e instanceof GroupFulfilmentRefused)) throw e;
      return null;
    }
    if (await this.strandedActive(tx, grantId)) throw new MoveItemRefused('no_target');
    return null;
  }

  async empty(tx: Prisma.TransactionClient, job: ConfigMoveJob, configId: string): Promise<null> {
    const grantId = await this.audited(tx, job, configId, 'config_retire', () => this.actions.retire(tx, { configId, actor: actorOf(job) }));
    if (!(await this.strandedActive(tx, grantId))) return null;
    const at = new Date();
    if (job.orphans === EvictOrphans.refund) await this.drains.orphans.refund(tx, grantId, at, job.actorUserId);
    else await this.drains.orphans.pause(tx, grantId, at);
    return null;
  }

  /** One act on the config, written down against it; answers the config's Grant. */
  private async audited(tx: Prisma.TransactionClient, job: ConfigMoveJob, configId: string, action: 'config_move' | 'config_retire', act: () => Promise<void>): Promise<string> {
    const config = await tx.config.findUnique({ where: { id: configId }, select: { grantId: true, tenantId: true } });
    if (!config) {
      await act(); // refuses it as `config_not_found`
      return configId;
    }
    await auditedConfigAct(tx, { userId: job.actorUserId, ip: job.actorIp }, config.tenantId, configId, action, job.reason, act);
    return config.grantId;
  }

  /** An active Grant with no live config left anywhere: the user would have no line. */
  private async strandedActive(tx: Prisma.TransactionClient, grantId: string): Promise<boolean> {
    const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { status: true } });
    if (grant?.status !== GrantStatus.active) return false;
    return (await tx.config.count({ where: { grantId, ...LIVE_CONFIG } })) === 0;
  }
}

const actorOf = (job: ConfigMoveJob) => ({ actorType: ActorType.admin, actorId: job.actorUserId });
