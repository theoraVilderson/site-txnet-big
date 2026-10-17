import { Injectable, Logger } from '@nestjs/common';
import { ConfigMoveJob, ConfigMoveJobKind, ConfigMoveJobStatus, EvictOrphans, InboundAudience, Prisma } from '@prisma/client';

import { auditMoveJob } from '../grant-audit/grant-audit';
import { ConfigMoveJobView, CONFIG_MOVE_JOB_MAX_CONFIGS, jobOutcomes, moveJobView, stopJob } from '../payment/gift/config-move-job';
import { GrantBulkPage } from '../payment/gift/grant-bulk-job.schema';
import { bulkFingerprint } from '../payment/gift/reseller-grants-bulk';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { applyRelease, insertReleaseSelection, ReleaseSource } from '../traffic/inbound-release';
import { RELEASE_MODES } from './panel-registration.schema';
import { panelScopeOf, SystemsActor } from './panel-scope';
import { SystemsRefused } from './systems-read';

export type ReleaseMode = (typeof RELEASE_MODES)[number];

const KIND_OF: Record<ReleaseMode, ConfigMoveJobKind> = { move: ConfigMoveJobKind.release_move, empty: ConfigMoveJobKind.release_empty };
const RELEASE_KINDS = Object.values(KIND_OF);

export type InboundReleaseInput = { requestId: string; groups: string[]; mode: ReleaseMode; orphans?: EvictOrphans; reason: string };

/** The admin and where the request came from: the job's audit rows name both. */
export type ReleaseActor = SystemsActor & { ip: string };

const isDuplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const auditActor = (actor: ReleaseActor) => ({ userId: actor.adminId, ip: actor.ip });

/**
 * Releasing an inbound from groups whose Grants have live configs there
 * (F-027-es, ADR-0127 decision 6) — the answer to `inbound_has_configs`. The
 * admin chooses, never a side effect: `move` or `empty`, run as a kind of
 * F-311-ad's config move job, so the drain, the progress event and the
 * outcomes are that job's.
 *
 * At the start, under the panel's fulfilment lock: the configs are frozen as
 * items — every tenant's, a platform group serves resellers' users — and an
 * `inbound_release` row per group stops new placements there. **The listing
 * changes only when the job ends** (`applyRelease`, in the drain); a cancel
 * removes the hold and leaves the listing as it was. Nothing to move ends the
 * job at once. On the cross-tenant pool, every query carrying the scope, as
 * `MemberInboundsService`; the job is the actor's tenant's.
 */
@Injectable()
export class InboundReleaseService {
  private readonly logger = new Logger(InboundReleaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  async start(actor: ReleaseActor, panelId: string, remoteId: string, input: InboundReleaseInput): Promise<ConfigMoveJobView> {
    const scope = await panelScopeOf(this.prisma, actor);
    const panel = await this.crossTenant.panel.findFirst({ where: { id: panelId, ...scope }, select: { id: true } });
    if (!panel) throw new SystemsRefused('panel_not_found');
    const groupIds = [...new Set(input.groups)].sort();
    const source: ReleaseSource = { panelId: panel.id, remoteId, groupIds };
    const fingerprint = bulkFingerprint({ source, mode: input.mode, orphans: input.orphans ?? null, reason: input.reason });
    const key = { tenantId_requestId: { tenantId: actor.tenantId, requestId: input.requestId } };
    try {
      const job = await this.crossTenant.$transaction(async (tx) => {
        const prior = await tx.configMoveJob.findUnique({ where: key });
        if (prior) return sameOrReused(prior, fingerprint);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`panel_inbound:${panel.id}`}))`;
        const groups = await this.sellers(tx, scope.tenantId, source);
        const created = await tx.configMoveJob.create({
          data: { tenantId: actor.tenantId, requestId: input.requestId, fingerprint, actorUserId: actor.adminId, actorIp: actor.ip, reason: input.reason, kind: KIND_OF[input.mode], source, orphans: input.mode === 'empty' ? (input.orphans ?? null) : null, total: 0 },
        });
        const total = await insertReleaseSelection(tx, created.id, source, CONFIG_MOVE_JOB_MAX_CONFIGS + 1);
        if (total > CONFIG_MOVE_JOB_MAX_CONFIGS) throw new SystemsRefused('selection_too_large');
        await tx.inboundRelease.createMany({ data: groups.map((g) => ({ groupId: g.id, panelId: panel.id, inboundRemoteId: remoteId, tenantId: g.tenantId, jobId: created.id })) });
        const started = await tx.configMoveJob.update({ where: { id: created.id }, data: { total, ...(total === 0 ? { status: ConfigMoveJobStatus.done, finishedAt: new Date() } : {}) } });
        if (total === 0) await applyRelease(tx, started);
        await auditMoveJob(tx, auditActor(actor), actor.tenantId, 'config_move_start', started.id, null, { source, kind: started.kind, orphans: started.orphans, total }, input.reason);
        return moveJobView(started);
      });
      this.logger.log(`panel ${panel.id} inbound ${remoteId}: release from [${groupIds.join(', ')}] by ${input.mode}, job ${job.id} (${job.total} config(s)), by ${actor.adminId}`);
      return job;
    } catch (e) {
      // A concurrent confirm with this id created the job first; its answer is this one's.
      if (!isDuplicate(e)) throw e;
      const prior = await this.crossTenant.configMoveJob.findUnique({ where: key });
      if (!prior) throw e;
      return sameOrReused(prior, fingerprint);
    }
  }

  job(actor: SystemsActor, jobId: string): Promise<ConfigMoveJobView> {
    return this.crossTenant.$transaction(async (tx) => moveJobView(await this.find(tx, actor, jobId)));
  }

  outcomes(actor: SystemsActor, jobId: string, page: GrantBulkPage) {
    return this.crossTenant.$transaction(async (tx) => jobOutcomes(tx, await this.find(tx, actor, jobId), page));
  }

  /** Stops the job: what it moved stays moved, the hold goes, and the listing is as it was. */
  cancel(actor: ReleaseActor, jobId: string): Promise<ConfigMoveJobView> {
    return this.crossTenant.$transaction(async (tx) => moveJobView(await stopJob(tx, auditActor(actor), await this.find(tx, actor, jobId))));
  }

  /**
   * Each group named is a member of the panel in scope that sells the inbound
   * now — every member while it is `every_group`, else the listed ones —
   * and is not already being released from it.
   */
  private async sellers(tx: Prisma.TransactionClient, scopeTenantId: string | null, source: ReleaseSource) {
    const inbound = await tx.panelInbound.findUnique({ where: { panelId_remoteId: { panelId: source.panelId, remoteId: source.remoteId } }, select: { audience: true } });
    if (!inbound) throw new SystemsRefused('inbound_not_found');
    const members = await tx.panelGroupMember.findMany({ where: { panelId: source.panelId, groupId: { in: source.groupIds }, group: { tenantId: scopeTenantId } }, select: { groupId: true, group: { select: { tenantId: true } } } });
    if (members.length !== source.groupIds.length) throw new SystemsRefused('member_not_found');
    if (inbound.audience === InboundAudience.listed) {
      const listed = await tx.panelGroupMemberInbound.count({ where: { panelId: source.panelId, inboundRemoteId: source.remoteId, groupId: { in: source.groupIds } } });
      if (listed !== source.groupIds.length) throw new SystemsRefused('not_a_seller');
    }
    const held = await tx.inboundRelease.count({ where: { panelId: source.panelId, inboundRemoteId: source.remoteId, groupId: { in: source.groupIds } } });
    if (held > 0) throw new SystemsRefused('already_releasing');
    return members.map((m) => ({ id: m.groupId, tenantId: m.group.tenantId }));
  }

  /** A release job of the actor's tenant; any other, or a reseller's move job, reads as absent. */
  private async find(tx: Prisma.TransactionClient, actor: SystemsActor, jobId: string): Promise<ConfigMoveJob> {
    const job = await tx.configMoveJob.findFirst({ where: { id: jobId, tenantId: actor.tenantId, kind: { in: RELEASE_KINDS } } });
    if (!job) throw new SystemsRefused('job_not_found');
    return job;
  }
}

function sameOrReused(prior: ConfigMoveJob, fingerprint: string): ConfigMoveJobView {
  if (prior.fingerprint !== fingerprint) throw new SystemsRefused('request_reused');
  return moveJobView(prior);
}
