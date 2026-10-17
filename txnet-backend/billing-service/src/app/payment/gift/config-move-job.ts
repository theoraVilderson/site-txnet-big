import { Injectable, Logger } from '@nestjs/common';
import { ActorType, ConfigMoveJob, ConfigMoveJobStatus, ConfigStatus, DesiredRemote, Prisma } from '@prisma/client';
import { AdmittedReseller, OutboxEventType, ResellerAccess, ResellerAccessRefused, ResellerActor, runWithTenant, SupportConsentRefused, tenantTransaction } from '@txnet-backend/shared-core';

import { auditedConfigAct, auditMoveJob } from '../../grant-audit/grant-audit';
import { errorLine } from '../../log-line';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigActionRefused, ConfigActionsService } from '../../traffic/config-actions';
import { ConfigMoveJobBody, ConfigMoveSelection, ConfigMoveSource } from './config-move-job.schema';
import { countMoveSelection, insertMoveSelection, moveTargetWhere } from './config-move-selection';
import { GrantBulkPage } from './grant-bulk-job.schema';
import { JobProgress, jobProgress } from './job-progress';
import { bulkFingerprint } from './reseller-grants-bulk';
import { AdminActor, ResellerUserGrantsRefused } from './reseller-user-grants.service';

/** The most configs one job may hold; a larger move is split by panel. */
export const CONFIG_MOVE_JOB_MAX_CONFIGS = 100_000;

/** Configs moved per drain (D-63): each is a retire and a provision, so a tick stays short. */
export const CONFIG_MOVE_BATCH_SIZE = 50;

/** A throw nobody named is tried on this many drains, then that config is `failed`. */
export const CONFIG_MOVE_JOB_ATTEMPTS = 3;

/** Days after a job ended that its items go; the job row and its counts stay. */
export const CONFIG_MOVE_RETENTION_DAYS = 30;

/** An item's outcome when its move threw on every attempt. */
export const CONFIG_MOVE_FAILED = 'failed';

/** A config whose Grant is already served on the target with that protocol: a move would give it a second line there. */
export const ALREADY_ON_TARGET = 'already_on_target';

export type ConfigMoveJobRejection = 'request_reused' | 'selection_empty' | 'selection_too_large' | 'job_not_found' | 'panel_not_found' | 'same_panel';

export class ConfigMoveJobRefused extends Error {
  constructor(
    readonly reason: ConfigMoveJobRejection,
    detail = '',
  ) {
    super(`config move job refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'ConfigMoveJobRefused';
  }
}

export type ConfigMoveJobView = { id: string; requestId: string; source: ConfigMoveSource; toPanelId: string; reason: string } & JobProgress<ConfigMoveJobStatus>;

export type ConfigMoveOutcome = { configId: string; ok: true; movedTo: string } | { configId: string; ok: false; reason: string };

const view = (j: ConfigMoveJob): ConfigMoveJobView => ({
  id: j.id,
  requestId: j.requestId,
  source: j.source as ConfigMoveSource,
  toPanelId: j.toPanelId,
  reason: j.reason,
  ...jobProgress(j),
});

/** What a job's audit rows say it was and where it stood: never its configs, which have rows of their own. */
const auditState = (j: ConfigMoveJob) => ({ source: j.source, toPanelId: j.toPanelId, status: j.status, total: j.total, ok: j.okCount, refused: j.refusedCount, failed: j.failedCount });

const isDuplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** The job's tenant re-reads its open page (C-14): a batch moved, the job ended or was cancelled. */
function announceProgress(tx: Prisma.TransactionClient, job: Pick<ConfigMoveJob, 'id' | 'tenantId'>) {
  return tx.outboxEvent.create({
    data: { aggregate: 'network.config_move_job', aggregateId: job.id, type: OutboxEventType.CONFIG_MOVE_JOB_PROGRESS, payload: { tenantId: job.tenantId, jobId: job.id } },
  });
}

/**
 * A reseller's admin moves many configs to one panel (F-311-ad, D-63): every
 * live config on a source panel, or of the users named, to a target from
 * `move-targets` (F-311-v1). The worker moves them (`ConfigMoveJobDrainService`)
 * — a panel can hold thousands.
 *
 * **The selection is frozen at the confirm**, as a bulk job by filter
 * (F-311-u2): the configs that matched are the job's items in the start's own
 * transaction. **One `requestId`, one job.** The door is `ResellerAccess` on
 * `grant.repair`, as one move: `staffWrite` to start or cancel, `read` to
 * count and watch.
 */
@Injectable()
export class ResellerConfigMoveJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  count(actor: ResellerActor, tenantId: string, selection: ConfigMoveSelection): Promise<number> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => countMoveSelection(tx, tenantId, selection)));
  }

  start(actor: AdminActor, tenantId: string, body: ConfigMoveJobBody): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () => this.startAdmitted(actor, tenantId, body));
  }

  job(actor: ResellerActor, tenantId: string, jobId: string): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, async (tx) => view(await this.find(tx, tenantId, jobId))));
  }

  /** The reseller's move jobs, newest first. */
  list(actor: ResellerActor, tenantId: string, page: Pick<GrantBulkPage, 'page' | 'pageSize'>) {
    const { page: p = 1, pageSize = 20 } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const where = { tenantId };
        const [rows, total] = await Promise.all([
          tx.configMoveJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * pageSize, take: pageSize }),
          tx.configMoveJob.count({ where }),
        ]);
        return { rows: rows.map(view), page: p, pageSize, total };
      }),
    );
  }

  /** The configs a job has reached, in the order reached; `problems` keeps the refused and failed — "who did not move". */
  outcomes(actor: ResellerActor, tenantId: string, jobId: string, page: GrantBulkPage) {
    const { page: p = 1, pageSize = 20, problems } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const job = await this.find(tx, tenantId, jobId);
        const items = await tx.configMoveJobItem.findMany({
          where: { jobId: job.id, doneAt: { not: null }, ...(problems ? { ok: false } : {}) },
          orderBy: [{ doneAt: 'asc' }, { configId: 'asc' }],
          skip: (p - 1) * pageSize,
          take: pageSize,
        });
        const rows = items.map((i): ConfigMoveOutcome => (i.ok && i.movedTo ? { configId: i.configId, ok: true, movedTo: i.movedTo } : { configId: i.configId, ok: false, reason: i.reason ?? CONFIG_MOVE_FAILED }));
        return { rows, page: p, pageSize, purgedAt: job.purgedAt?.toISOString() ?? null };
      }),
    );
  }

  /** Stops a running job: the configs it moved stay moved, the rest are never reached. A job already ended is answered as it is. */
  cancel(actor: AdminActor, tenantId: string, jobId: string): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const before = await this.find(tx, tenantId, jobId);
        const { count } = await tx.configMoveJob.updateMany({ where: { id: jobId, status: ConfigMoveJobStatus.running }, data: { status: ConfigMoveJobStatus.cancelled, finishedAt: new Date() } });
        const after = await this.find(tx, tenantId, jobId);
        if (count > 0) {
          await auditMoveJob(tx, actor, tenantId, 'config_move_cancel', jobId, auditState(before), auditState(after), null);
          await announceProgress(tx, after);
        }
        return view(after);
      }),
    );
  }

  private async startAdmitted(actor: AdminActor, tenantId: string, body: ConfigMoveJobBody): Promise<ConfigMoveJobView> {
    const { requestId, ...command } = body;
    const fingerprint = bulkFingerprint(command);
    const key = { tenantId_requestId: { tenantId, requestId } };
    try {
      return await tenantTransaction(this.prisma, async (tx) => {
        const prior = await tx.configMoveJob.findUnique({ where: key });
        if (prior) return sameOrReused(prior, fingerprint);
        if ('panelId' in command.source && command.source.panelId === command.toPanelId) throw new ConfigMoveJobRefused('same_panel', command.toPanelId);
        const target = await tx.panel.findFirst({ where: { id: command.toPanelId, ...moveTargetWhere(tenantId) }, select: { id: true } });
        if (!target) throw new ConfigMoveJobRefused('panel_not_found', command.toPanelId);

        const job = await tx.configMoveJob.create({
          data: { tenantId, requestId, fingerprint, actorUserId: actor.userId, actorIp: actor.ip, reason: command.reason, source: command.source, toPanelId: command.toPanelId, total: 0 },
        });
        const total = await insertMoveSelection(tx, job.id, tenantId, command, CONFIG_MOVE_JOB_MAX_CONFIGS + 1);
        if (total === 0) throw new ConfigMoveJobRefused('selection_empty');
        if (total > CONFIG_MOVE_JOB_MAX_CONFIGS) throw new ConfigMoveJobRefused('selection_too_large', String(CONFIG_MOVE_JOB_MAX_CONFIGS));
        const started = await tx.configMoveJob.update({ where: { id: job.id }, data: { total } });
        await auditMoveJob(tx, actor, tenantId, 'config_move_start', job.id, null, auditState(started), command.reason);
        return view(started);
      });
    } catch (e) {
      // A concurrent confirm with this id created the job first; its answer is this one's.
      if (!isDuplicate(e)) throw e;
      const prior = await tenantTransaction(this.prisma, (tx) => tx.configMoveJob.findUnique({ where: key }));
      if (!prior) throw e;
      return sameOrReused(prior, fingerprint);
    }
  }

  /** The job, only if it is this reseller's: the query says the tenant (C-15), as RLS does. */
  private async find(tx: Prisma.TransactionClient, tenantId: string, jobId: string): Promise<ConfigMoveJob> {
    const job = await tx.configMoveJob.findFirst({ where: { id: jobId, tenantId } });
    if (!job) throw new ConfigMoveJobRefused('job_not_found', jobId);
    return job;
  }

  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: (admitted: AdmittedReseller) => Promise<T>): Promise<T> {
    try {
      return await this.access.for('grant.repair').runIncludingPlatform(actor, tenantId, capability, work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused || e instanceof SupportConsentRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}

function sameOrReused(prior: ConfigMoveJob, fingerprint: string): ConfigMoveJobView {
  if (prior.fingerprint !== fingerprint) throw new ConfigMoveJobRefused('request_reused', prior.requestId);
  return view(prior);
}

export type ConfigMoveDrainResult = { jobs: number; moved: number; finished: number };

type Item = { configId: string; attempts: number };
type ItemResult = 'ok' | 'refused' | 'failed' | 'retry' | 'skipped';

/** Ended jobs purged per call: each is one delete of up to 100 000 rows. */
const PURGE_JOBS_PER_CALL = 5;
const DAY_MS = 86_400_000;

/** Thrown inside a move's transaction when another drain already gave the item its outcome: the move rolls back. */
class ItemAlreadyDone extends Error {}

/** A refusal of the job's own, beside `ConfigActions.move`'s: kept as the item's outcome at once. */
class ItemRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * One batch of every running move job (F-311-ad), asked by `worker-service`'s
 * `config_move_job_drain` tick over the internal seam (ADR-0027): at most
 * `CONFIG_MOVE_BATCH_SIZE` pending items, oldest job first, each moved **in
 * its job's tenant, as the job's admin**, by `ConfigActions.move` and audited
 * as the single move is (`config_move`, the job's reason).
 *
 * **An item's outcome commits with its move**: marking it done is in the
 * move's transaction, conditional on not done, so two drains racing on one
 * item move it once, and a retry never reads its own finished move as
 * `config_retired`. A refusal is kept at once; a throw nobody named is tried
 * on `CONFIG_MOVE_JOB_ATTEMPTS` drains, then `failed`. Each job's batch ends
 * with its counts and a progress event (C-14).
 */
@Injectable()
export class ConfigMoveJobDrainService {
  private readonly logger = new Logger(ConfigMoveJobDrainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly actions: ConfigActionsService,
  ) {}

  async drain(now: Date = new Date()): Promise<ConfigMoveDrainResult> {
    const pending = await this.crossTenant.configMoveJobItem.findMany({
      where: { doneAt: null, job: { status: ConfigMoveJobStatus.running } },
      orderBy: [{ job: { createdAt: 'asc' } }, { configId: 'asc' }],
      take: CONFIG_MOVE_BATCH_SIZE,
      select: { jobId: true, configId: true, attempts: true },
    });
    const jobIds = [...new Set(pending.map((i) => i.jobId))];
    const jobs = jobIds.length === 0 ? [] : await this.crossTenant.configMoveJob.findMany({ where: { id: { in: jobIds } } });

    let moved = 0;
    let finished = 0;
    for (const job of jobs) {
      const done = await runWithTenant({ id: job.tenantId }, () => this.drainJob(job, pending.filter((i) => i.jobId === job.id), now));
      moved += done.moved;
      if (done.finished) finished += 1;
    }
    if (moved > 0) this.logger.log(`moved ${moved} config(s) over ${jobs.length} move job(s), ${finished} finished`);
    return { jobs: jobs.length, moved, finished };
  }

  /** 30 days after a job ended its items go and `purgedAt` is set; the job row stays, so a repeated `requestId` still answers it. */
  async purge(now: Date = new Date()): Promise<{ jobs: number }> {
    const cutoff = new Date(now.getTime() - CONFIG_MOVE_RETENTION_DAYS * DAY_MS);
    const due = await this.crossTenant.configMoveJob.findMany({ where: { purgedAt: null, finishedAt: { lt: cutoff } }, orderBy: { finishedAt: 'asc' }, take: PURGE_JOBS_PER_CALL, select: { id: true, tenantId: true } });
    for (const job of due) {
      await runWithTenant({ id: job.tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          await tx.configMoveJobItem.deleteMany({ where: { jobId: job.id } });
          await tx.configMoveJob.updateMany({ where: { id: job.id, purgedAt: null }, data: { purgedAt: now } });
        }),
      );
    }
    return { jobs: due.length };
  }

  /** One job's share of the batch, in its tenant; a job cancelled since the scan is skipped. */
  private async drainJob(job: ConfigMoveJob, items: Item[], now: Date): Promise<{ moved: number; finished: boolean }> {
    const still = await tenantTransaction(this.prisma, (tx) => tx.configMoveJob.findFirst({ where: { id: job.id, status: ConfigMoveJobStatus.running }, select: { id: true } }));
    if (!still) return { moved: 0, finished: false };

    const counts = { okCount: 0, refusedCount: 0, failedCount: 0 };
    for (const item of items) {
      const result = await this.moveOne(job, item, now);
      if (result === 'ok') counts.okCount += 1;
      else if (result === 'refused') counts.refusedCount += 1;
      else if (result === 'failed') counts.failedCount += 1;
    }

    return tenantTransaction(this.prisma, async (tx) => {
      await tx.configMoveJob.update({ where: { id: job.id }, data: { okCount: { increment: counts.okCount }, refusedCount: { increment: counts.refusedCount }, failedCount: { increment: counts.failedCount } } });
      const left = await tx.configMoveJobItem.count({ where: { jobId: job.id, doneAt: null } });
      const ended = left === 0 ? (await tx.configMoveJob.updateMany({ where: { id: job.id, status: ConfigMoveJobStatus.running }, data: { status: ConfigMoveJobStatus.done, finishedAt: now } })).count > 0 : false;
      await announceProgress(tx, job);
      return { moved: counts.okCount, finished: ended };
    });
  }

  /** One config, moved and marked in one transaction; a refusal or a last failed attempt is marked after. */
  private async moveOne(job: ConfigMoveJob, item: Item, now: Date): Promise<ItemResult> {
    const actor = { actorType: ActorType.admin, actorId: job.actorUserId };
    const where = { jobId: job.id, configId: item.configId, doneAt: null };
    try {
      await tenantTransaction(this.prisma, async (tx) => {
        await this.refuseIfOnTarget(tx, item.configId, job.toPanelId);
        const movedTo = await auditedConfigAct(tx, { userId: job.actorUserId, ip: job.actorIp }, job.tenantId, item.configId, 'config_move', job.reason, async () =>
          (await this.actions.move(tx, { configId: item.configId, toPanelId: job.toPanelId, actor })).configId,
        );
        const { count } = await tx.configMoveJobItem.updateMany({ where, data: { attempts: { increment: 1 }, doneAt: now, ok: true, movedTo } });
        if (count === 0) throw new ItemAlreadyDone();
      });
      return 'ok';
    } catch (e) {
      if (e instanceof ItemAlreadyDone) return 'skipped';
      if (e instanceof ConfigActionRefused || e instanceof ItemRefused) return this.mark(where, now, e.reason, 'refused');
      if (item.attempts + 1 < CONFIG_MOVE_JOB_ATTEMPTS) {
        this.logger.warn(`config ${item.configId} of move job ${job.id} threw, tried again next drain: ${errorLine(e)}`);
        await tenantTransaction(this.prisma, (tx) => tx.configMoveJobItem.updateMany({ where, data: { attempts: { increment: 1 } } }));
        return 'retry';
      }
      this.logger.warn(`config ${item.configId} of move job ${job.id} failed on its last attempt: ${errorLine(e)}`);
      return this.mark(where, now, CONFIG_MOVE_FAILED, 'failed');
    }
  }

  private async mark(where: { jobId: string; configId: string; doneAt: null }, now: Date, reason: string, result: 'refused' | 'failed'): Promise<ItemResult> {
    const { count } = await tenantTransaction(this.prisma, (tx) => tx.configMoveJobItem.updateMany({ where, data: { attempts: { increment: 1 }, doneAt: now, ok: false, reason } }));
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
    if (held) throw new ItemRefused(ALREADY_ON_TARGET);
  }
}
