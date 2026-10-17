import { Injectable } from '@nestjs/common';
import { ConfigMoveJob, ConfigMoveJobKind, ConfigMoveJobStatus, EvictOrphans, Prisma } from '@prisma/client';
import { AdmittedReseller, OutboxEventType, ResellerAccess, ResellerAccessRefused, ResellerActor, SupportConsentRefused, tenantTransaction } from '@txnet-backend/shared-core';

import { AuditActor, auditMoveJob } from '../../grant-audit/grant-audit';
import { PrismaService } from '../../prisma/prisma.service';
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

/** `source` is the selection a reseller named, or a release's `{panelId, remoteId, groupIds}` (F-027-es). */
export type ConfigMoveJobView = {
  id: string;
  requestId: string;
  kind: ConfigMoveJobKind;
  source: ConfigMoveSource | Record<string, unknown>;
  toPanelId: string | null;
  orphans: EvictOrphans | null;
  reason: string;
} & JobProgress<ConfigMoveJobStatus>;

/** `movedTo` is the new config of a move to a panel; null where the next placement chose (a release). */
export type ConfigMoveOutcome = { configId: string; ok: true; movedTo: string | null } | { configId: string; ok: false; reason: string };

/** A move job as its page reads it, whichever kind. */
export const moveJobView = (j: ConfigMoveJob): ConfigMoveJobView => ({
  id: j.id,
  requestId: j.requestId,
  kind: j.kind,
  source: j.source as ConfigMoveJobView['source'],
  toPanelId: j.toPanelId,
  orphans: j.orphans,
  reason: j.reason,
  ...jobProgress(j),
});
const view = moveJobView;

/** What a job's audit rows say it was and where it stood: never its configs, which have rows of their own. */
const auditState = (j: ConfigMoveJob) => ({ source: j.source, toPanelId: j.toPanelId, status: j.status, total: j.total, ok: j.okCount, refused: j.refusedCount, failed: j.failedCount });

const isDuplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** The job's tenant re-reads its open page (C-14): a batch moved, the job ended or was cancelled. */
export function announceProgress(tx: Prisma.TransactionClient, job: Pick<ConfigMoveJob, 'id' | 'tenantId'>) {
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
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, async (tx) => jobOutcomes(tx, await this.find(tx, tenantId, jobId), page)));
  }

  /** Stops a running job (`stopJob`): the configs it moved stay moved, the rest are never reached. */
  cancel(actor: AdminActor, tenantId: string, jobId: string): Promise<ConfigMoveJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const job = await this.find(tx, tenantId, jobId);
        return view(await stopJob(tx, actor, job));
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

/**
 * The configs a job has reached, in the order reached, either kind; `problems`
 * keeps the refused and failed — "who did not move". No rows once purged.
 */
export async function jobOutcomes(tx: Prisma.TransactionClient, job: ConfigMoveJob, page: GrantBulkPage) {
  const { page: p = 1, pageSize = 20, problems } = page;
  const items = await tx.configMoveJobItem.findMany({
    where: { jobId: job.id, doneAt: { not: null }, ...(problems ? { ok: false } : {}) },
    orderBy: [{ doneAt: 'asc' }, { configId: 'asc' }],
    skip: (p - 1) * pageSize,
    take: pageSize,
  });
  const rows = items.map((i): ConfigMoveOutcome => (i.ok ? { configId: i.configId, ok: true, movedTo: i.movedTo } : { configId: i.configId, ok: false, reason: i.reason ?? CONFIG_MOVE_FAILED }));
  return { rows, page: p, pageSize, purgedAt: job.purgedAt?.toISOString() ?? null };
}

/**
 * Stops a running job, either kind: the configs it reached stay as they are,
 * the rest are never reached, and a release's hold on new placements goes
 * with it — the listing is unchanged (F-027-es). Written down once
 * (`config_move_cancel`) and told to the page; an ended job is answered as it is.
 */
export async function stopJob(tx: Prisma.TransactionClient, actor: AuditActor, job: ConfigMoveJob): Promise<ConfigMoveJob> {
  const { count } = await tx.configMoveJob.updateMany({ where: { id: job.id, status: ConfigMoveJobStatus.running }, data: { status: ConfigMoveJobStatus.cancelled, finishedAt: new Date() } });
  const after = await tx.configMoveJob.findUniqueOrThrow({ where: { id: job.id } });
  if (count === 0) return after;
  await tx.inboundRelease.deleteMany({ where: { jobId: job.id } });
  await auditMoveJob(tx, actor, job.tenantId, 'config_move_cancel', job.id, auditState(job), auditState(after), null);
  await announceProgress(tx, after);
  return after;
}
