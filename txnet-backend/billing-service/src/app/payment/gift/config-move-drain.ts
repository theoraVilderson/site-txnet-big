import { Injectable, Logger } from '@nestjs/common';
import { ActorType, ConfigMoveJob, ConfigMoveJobKind, ConfigMoveJobStatus, ConfigStatus, DesiredRemote, Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { auditedConfigAct } from '../../grant-audit/grant-audit';
import { errorLine } from '../../log-line';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigActionRefused, ConfigActionsService } from '../../traffic/config-actions';
import { applyRelease, InboundReleaseActs, MoveItemRefused } from '../../traffic/inbound-release';
import { announceProgress, CONFIG_MOVE_BATCH_SIZE, CONFIG_MOVE_FAILED, CONFIG_MOVE_JOB_ATTEMPTS, CONFIG_MOVE_RETENTION_DAYS } from './config-move-job';

export type ConfigMoveDrainResult = { jobs: number; moved: number; finished: number };

type Item = { configId: string; tenantId: string; attempts: number };
type ItemResult = 'ok' | 'refused' | 'failed' | 'retry' | 'skipped';
type ItemWhere = { jobId: string; configId: string; doneAt: null };

/** Ended jobs purged per call: each is one delete of up to 100 000 rows. */
const PURGE_JOBS_PER_CALL = 5;
const DAY_MS = 86_400_000;

/** Thrown inside a move's transaction when another drain already gave the item its outcome: the move rolls back. */
class ItemAlreadyDone extends Error {}

/**
 * One batch of every running move job (F-311-ad), asked by `worker-service`'s
 * `config_move_job_drain` tick over the internal seam (ADR-0027): at most
 * `CONFIG_MOVE_BATCH_SIZE` pending items, oldest job first, each acted on
 * **in its config's tenant, as the job's admin**, by its kind: a move to a
 * panel (`ConfigActions.move`, audited as the single move), or one of a
 * release's two ways out (`InboundReleaseActs`, F-027-es).
 *
 * **An item's outcome commits with its act**: marking it done is in the act's
 * transaction, conditional on not done, so two drains racing on one item act
 * once, and a retry never reads its own finished move as `config_retired`. A
 * refusal is kept at once; a throw nobody named is tried on
 * `CONFIG_MOVE_JOB_ATTEMPTS` drains, then `failed`. Each job's batch ends
 * with its counts and a progress event (C-14); a release's last batch applies
 * the release, in the same transaction that ends the job.
 */
@Injectable()
export class ConfigMoveJobDrainService {
  private readonly logger = new Logger(ConfigMoveJobDrainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly actions: ConfigActionsService,
    private readonly release: InboundReleaseActs,
  ) {}

  async drain(now: Date = new Date()): Promise<ConfigMoveDrainResult> {
    const pending = await this.crossTenant.configMoveJobItem.findMany({
      where: { doneAt: null, job: { status: ConfigMoveJobStatus.running } },
      orderBy: [{ job: { createdAt: 'asc' } }, { configId: 'asc' }],
      take: CONFIG_MOVE_BATCH_SIZE,
      select: { jobId: true, configId: true, tenantId: true, attempts: true },
    });
    const jobIds = [...new Set(pending.map((i) => i.jobId))];
    const jobs = jobIds.length === 0 ? [] : await this.crossTenant.configMoveJob.findMany({ where: { id: { in: jobIds } } });

    let moved = 0;
    let finished = 0;
    for (const job of jobs) {
      const done = await this.drainJob(job, pending.filter((i) => i.jobId === job.id), now);
      moved += done.moved;
      if (done.finished) finished += 1;
    }
    if (moved > 0) this.logger.log(`moved ${moved} config(s) over ${jobs.length} move job(s), ${finished} finished`);
    return { jobs: jobs.length, moved, finished };
  }

  /** 30 days after a job ended its items go and `purgedAt` is set; the job row stays, so a repeated `requestId` still answers it. */
  async purge(now: Date = new Date()): Promise<{ jobs: number }> {
    const cutoff = new Date(now.getTime() - CONFIG_MOVE_RETENTION_DAYS * DAY_MS);
    const due = await this.crossTenant.configMoveJob.findMany({ where: { purgedAt: null, finishedAt: { lt: cutoff } }, orderBy: { finishedAt: 'asc' }, take: PURGE_JOBS_PER_CALL, select: { id: true } });
    for (const job of due) {
      await this.crossTenant.$transaction(async (tx) => {
        await tx.configMoveJobItem.deleteMany({ where: { jobId: job.id } });
        await tx.configMoveJob.updateMany({ where: { id: job.id, purgedAt: null }, data: { purgedAt: now } });
      });
    }
    return { jobs: due.length };
  }

  /**
   * One job's share of the batch; a job cancelled since the scan is skipped.
   * The end is on the cross-tenant pool: a release's items and listings are
   * every tenant's, and a platform group's rows carry `tenantId` null.
   */
  private async drainJob(job: ConfigMoveJob, items: Item[], now: Date): Promise<{ moved: number; finished: boolean }> {
    const still = await this.crossTenant.configMoveJob.findFirst({ where: { id: job.id, status: ConfigMoveJobStatus.running }, select: { id: true } });
    if (!still) return { moved: 0, finished: false };

    const counts = { okCount: 0, refusedCount: 0, failedCount: 0 };
    for (const item of items) {
      const result = await this.actOne(job, item, now);
      if (result === 'ok') counts.okCount += 1;
      else if (result === 'refused') counts.refusedCount += 1;
      else if (result === 'failed') counts.failedCount += 1;
    }

    return this.crossTenant.$transaction(async (tx) => {
      await tx.configMoveJob.update({ where: { id: job.id }, data: { okCount: { increment: counts.okCount }, refusedCount: { increment: counts.refusedCount }, failedCount: { increment: counts.failedCount } } });
      const left = await tx.configMoveJobItem.count({ where: { jobId: job.id, doneAt: null } });
      const ended = left === 0 && (await tx.configMoveJob.updateMany({ where: { id: job.id, status: ConfigMoveJobStatus.running }, data: { status: ConfigMoveJobStatus.done, finishedAt: now } })).count > 0;
      if (ended && job.kind !== ConfigMoveJobKind.to_panel) await applyRelease(tx, job);
      await announceProgress(tx, job);
      return { moved: counts.okCount, finished: ended };
    });
  }

  /** One config, acted on and marked in one transaction in its tenant; a refusal or a last failed attempt is marked after. */
  private async actOne(job: ConfigMoveJob, item: Item, now: Date): Promise<ItemResult> {
    const where = { jobId: job.id, configId: item.configId, doneAt: null };
    const inTenant = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => runWithTenant({ id: item.tenantId }, () => tenantTransaction(this.prisma, work));
    try {
      await inTenant(async (tx) => {
        const movedTo = await this.act(tx, job, item.configId);
        const { count } = await tx.configMoveJobItem.updateMany({ where, data: { attempts: { increment: 1 }, doneAt: now, ok: true, movedTo } });
        if (count === 0) throw new ItemAlreadyDone();
      });
      return 'ok';
    } catch (e) {
      if (e instanceof ItemAlreadyDone) return 'skipped';
      if (e instanceof ConfigActionRefused || e instanceof MoveItemRefused) return this.mark(inTenant, where, now, e.reason, 'refused');
      if (item.attempts + 1 < CONFIG_MOVE_JOB_ATTEMPTS) {
        this.logger.warn(`config ${item.configId} of move job ${job.id} threw, tried again next drain: ${errorLine(e)}`);
        await inTenant((tx) => tx.configMoveJobItem.updateMany({ where, data: { attempts: { increment: 1 } } }));
        return 'retry';
      }
      this.logger.warn(`config ${item.configId} of move job ${job.id} failed on its last attempt: ${errorLine(e)}`);
      return this.mark(inTenant, where, now, CONFIG_MOVE_FAILED, 'failed');
    }
  }

  /** The job's act on one config; answers the new config of a move to a panel, else null. */
  private act(tx: Prisma.TransactionClient, job: ConfigMoveJob, configId: string): Promise<string | null> {
    switch (job.kind) {
      case ConfigMoveJobKind.to_panel:
        return this.moveToPanel(tx, job, configId, job.toPanelId ?? '');
      case ConfigMoveJobKind.release_move:
        return this.release.move(tx, job, configId);
      case ConfigMoveJobKind.release_empty:
        return this.release.empty(tx, job, configId);
    }
  }

  private async moveToPanel(tx: Prisma.TransactionClient, job: ConfigMoveJob, configId: string, toPanelId: string): Promise<string> {
    await this.refuseIfOnTarget(tx, configId, toPanelId);
    const actor = { actorType: ActorType.admin, actorId: job.actorUserId };
    return auditedConfigAct(tx, { userId: job.actorUserId, ip: job.actorIp }, job.tenantId, configId, 'config_move', job.reason, async () =>
      (await this.actions.move(tx, { configId, toPanelId, actor })).configId,
    );
  }

  private async mark(inTenant: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>, where: ItemWhere, now: Date, reason: string, result: 'refused' | 'failed'): Promise<ItemResult> {
    const { count } = await inTenant((tx) => tx.configMoveJobItem.updateMany({ where, data: { attempts: { increment: 1 }, doneAt: now, ok: false, reason } }));
    return count > 0 ? result : 'skipped';
  }

  /** The Grant already has a live config of this protocol on the target: moving this one would give it a second line there. */
  private async refuseIfOnTarget(tx: Prisma.TransactionClient, configId: string, toPanelId: string) {
    const config = await tx.config.findFirst({ where: { id: configId }, select: { grantId: true, protocol: true } });
    if (!config) return; // the move refuses it as `config_not_found`
    const held = await tx.config.findFirst({
      where: { grantId: config.grantId, panelId: toPanelId, protocol: config.protocol, status: { not: ConfigStatus.retired }, desiredRemote: DesiredRemote.present, drainedAt: null },
      select: { id: true },
    });
    if (held) throw new MoveItemRefused('already_on_target');
  }
}
