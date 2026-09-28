import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrantBulkJob, GrantBulkJobStatus, Prisma } from '@prisma/client';
import { ResellerAccess, ResellerAccessRefused, ResellerActor, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { auditBulkJob } from '../../grant-audit/grant-audit';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GrantBulkCommand } from './grant-bulk.schema';
import { GrantBulkFilter, GrantBulkJobBody, GrantBulkPage } from './grant-bulk-job.schema';
import { countSelection, GrantBulkPanel, insertSelection, panelsOfSelection } from './grant-bulk-selection';
import { actOnce, bulkFingerprint, GRANT_BULK_FAILED, GrantBulkOutcome } from './reseller-grants-bulk';
import { AdminActor, ResellerUserGrantsRefused } from './reseller-user-grants.service';

/** The most Grants one job may hold. A reseller past it splits by panel or product; one job must not hold a tick for hours. */
export const GRANT_BULK_JOB_MAX_GRANTS = 100_000;

/** A throw nobody named is tried on this many drains, then that Grant is `failed` — a transient error retries, a broken Grant does not stall the job. */
export const GRANT_BULK_JOB_ATTEMPTS = 3;

export type GrantBulkJobRejection = 'request_reused' | 'selection_empty' | 'selection_too_large' | 'job_not_found';

export class GrantBulkJobRefused extends Error {
  constructor(
    readonly reason: GrantBulkJobRejection,
    detail = '',
  ) {
    super(`bulk job refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'GrantBulkJobRefused';
  }
}

export type GrantBulkJobView = {
  id: string;
  requestId: string;
  action: string;
  command: Record<string, unknown>;
  filter: GrantBulkFilter;
  status: GrantBulkJobStatus;
  total: number;
  processed: number;
  ok: number;
  refused: number;
  failed: number;
  createdAt: string;
  finishedAt: string | null;
  /** When its per-Grant outcomes were purged (F-311-u3); the counts above stay. */
  purgedAt: string | null;
};

const view = (j: GrantBulkJob): GrantBulkJobView => ({
  id: j.id,
  requestId: j.requestId,
  action: j.action,
  command: j.command as Record<string, unknown>,
  filter: j.filter as GrantBulkFilter,
  status: j.status,
  total: j.total,
  processed: j.okCount + j.refusedCount + j.failedCount,
  ok: j.okCount,
  refused: j.refusedCount,
  failed: j.failedCount,
  createdAt: j.createdAt.toISOString(),
  finishedAt: j.finishedAt?.toISOString() ?? null,
  purgedAt: j.purgedAt?.toISOString() ?? null,
});

/** What a job's audit rows say it was and where it stood: never its Grants, which have rows of their own. */
const auditState = (j: GrantBulkJob) => ({ action: j.action, command: j.command, filter: j.filter, status: j.status, total: j.total, ok: j.okCount, refused: j.refusedCount, failed: j.failedCount });

const isDuplicate = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/**
 * A reseller's admin acts on Grants chosen by a filter (F-311-u2): the same
 * acts as a bulk by id (F-311-u), run by the worker (`GrantBulkJobDrainService`)
 * instead of in the request — an outage is per panel, and a panel can hold
 * thousands of Grants.
 *
 * **The selection is frozen at the confirm** (user, 2026-09-28): the Grants
 * the filter matched then are the job's items, in the confirm's transaction,
 * so the count the admin saw is what is acted on and progress has a fixed
 * denominator. **One `requestId`, one job**: a repeat answers the same job and
 * selects nothing again; the same id with another body, or an id a bulk by id
 * already used, is `request_reused`.
 *
 * The door is `ResellerAccess`: `staffWrite` to start or cancel, `read` to
 * count and watch — a suspended reseller still sees a job it started finish.
 */
@Injectable()
export class ResellerGrantBulkJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ResellerAccess,
  ) {}

  count(actor: ResellerActor, tenantId: string, filter: GrantBulkFilter): Promise<number> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => countSelection(tx, tenantId, filter)));
  }

  /** The panels a filter can name (F-311-x1): those holding the reseller's Grants, the retired one that was down included. */
  panels(actor: ResellerActor, tenantId: string): Promise<GrantBulkPanel[]> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, (tx) => panelsOfSelection(tx, tenantId)));
  }

  start(actor: AdminActor, tenantId: string, body: GrantBulkJobBody): Promise<GrantBulkJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () => this.startAdmitted(actor, tenantId, body));
  }

  job(actor: ResellerActor, tenantId: string, jobId: string): Promise<GrantBulkJobView> {
    return this.admitted(actor, tenantId, 'read', () => tenantTransaction(this.prisma, async (tx) => view(await this.find(tx, tenantId, jobId))));
  }

  /** The reseller's jobs, newest first. */
  list(actor: ResellerActor, tenantId: string, page: Pick<GrantBulkPage, 'page' | 'pageSize'>) {
    const { page: p = 1, pageSize = 20 } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const where = { tenantId };
        const [rows, total] = await Promise.all([
          tx.grantBulkJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (p - 1) * pageSize, take: pageSize }),
          tx.grantBulkJob.count({ where }),
        ]);
        return { rows: rows.map(view), page: p, pageSize, total };
      }),
    );
  }

  /**
   * The Grants a job has reached, in the order it reached them, each as a bulk
   * by id answers it; `problems` keeps the refused and failed ones only — "who
   * did not get the +3 days". The job's counts are the totals. Once purged
   * (F-311-u3) there are no rows, and `purgedAt` says why.
   */
  outcomes(actor: ResellerActor, tenantId: string, jobId: string, page: GrantBulkPage) {
    const { page: p = 1, pageSize = 20, problems } = page;
    return this.admitted(actor, tenantId, 'read', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const job = await this.find(tx, tenantId, jobId);
        const items = await tx.grantBulkJobItem.findMany({
          where: { jobId, doneAt: { not: null }, ...(problems ? { ok: false } : {}) },
          orderBy: [{ doneAt: 'asc' }, { grantId: 'asc' }],
          skip: (p - 1) * pageSize,
          take: pageSize,
        });
        const kept = await tx.grantBulkOutcome.findMany({ where: { tenantId, requestId: job.requestId, grantId: { in: items.map((i) => i.grantId) } } });
        const byGrant = new Map(kept.map((o) => [o.grantId, o.outcome as GrantBulkOutcome]));
        const rows = items.map((i): GrantBulkOutcome => (i.failed ? { grantId: i.grantId, ok: false, reason: GRANT_BULK_FAILED } : (byGrant.get(i.grantId) ?? { grantId: i.grantId, ok: false, reason: GRANT_BULK_FAILED })));
        return { rows, page: p, pageSize, purgedAt: job.purgedAt?.toISOString() ?? null };
      }),
    );
  }

  /**
   * Stops a running job: the Grants it reached stand, the rest are never acted
   * on — written down as `grant_bulk_cancel` (F-311-u3). A finished or
   * cancelled job is answered as it is, and writes nothing.
   */
  cancel(actor: AdminActor, tenantId: string, jobId: string): Promise<GrantBulkJobView> {
    return this.admitted(actor, tenantId, 'staffWrite', () =>
      tenantTransaction(this.prisma, async (tx) => {
        const before = await this.find(tx, tenantId, jobId);
        const { count } = await tx.grantBulkJob.updateMany({ where: { id: jobId, status: GrantBulkJobStatus.running }, data: { status: GrantBulkJobStatus.cancelled, finishedAt: new Date() } });
        const after = await this.find(tx, tenantId, jobId);
        if (count > 0) await auditBulkJob(tx, actor, tenantId, 'grant_bulk_cancel', jobId, auditState(before), auditState(after), null);
        return view(after);
      }),
    );
  }

  private async startAdmitted(actor: AdminActor, tenantId: string, body: GrantBulkJobBody): Promise<GrantBulkJobView> {
    const { requestId, filter, ...command } = body;
    const fingerprint = bulkFingerprint({ ...command, filter });
    const key = { tenantId_requestId: { tenantId, requestId } };
    try {
      return await tenantTransaction(this.prisma, async (tx) => {
        const prior = await tx.grantBulkJob.findUnique({ where: key });
        if (prior) return sameOrReused(prior, fingerprint);
        const byIds = await tx.grantBulkOutcome.findFirst({ where: { tenantId, requestId }, select: { grantId: true } });
        if (byIds) throw new GrantBulkJobRefused('request_reused', requestId);

        const job = await tx.grantBulkJob.create({
          data: { tenantId, requestId, fingerprint, actorUserId: actor.userId, actorIp: actor.ip, action: command.action, command: command as Prisma.InputJsonValue, filter, total: 0 },
        });
        const total = await insertSelection(tx, job.id, tenantId, filter, GRANT_BULK_JOB_MAX_GRANTS + 1);
        if (total === 0) throw new GrantBulkJobRefused('selection_empty');
        if (total > GRANT_BULK_JOB_MAX_GRANTS) throw new GrantBulkJobRefused('selection_too_large', String(GRANT_BULK_JOB_MAX_GRANTS));
        const started = await tx.grantBulkJob.update({ where: { id: job.id }, data: { total } });
        // The admin's one decision, written once (F-311-u3); a repeat returned above and writes none.
        await auditBulkJob(tx, actor, tenantId, 'grant_bulk_start', job.id, null, auditState(started), command.reason);
        return view(started);
      });
    } catch (e) {
      // A concurrent confirm with this id created the job first; its answer is this one's.
      if (!isDuplicate(e)) throw e;
      const prior = await tenantTransaction(this.prisma, (tx) => tx.grantBulkJob.findUnique({ where: key }));
      if (!prior) throw e;
      return sameOrReused(prior, fingerprint);
    }
  }

  /** The job, only if it is this reseller's: the query says the tenant (C-15), as RLS does. */
  private async find(tx: Prisma.TransactionClient, tenantId: string, jobId: string): Promise<GrantBulkJob> {
    const job = await tx.grantBulkJob.findFirst({ where: { id: jobId, tenantId } });
    if (!job) throw new GrantBulkJobRefused('job_not_found', jobId);
    return job;
  }

  private async admitted<T>(actor: ResellerActor, tenantId: string, capability: 'read' | 'staffWrite', work: () => Promise<T>): Promise<T> {
    try {
      return await this.access.run(actor, tenantId, capability, work);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new ResellerUserGrantsRefused(e.reason, tenantId);
      throw e;
    }
  }
}

function sameOrReused(prior: GrantBulkJob, fingerprint: string): GrantBulkJobView {
  if (prior.fingerprint !== fingerprint) throw new GrantBulkJobRefused('request_reused', prior.requestId);
  return view(prior);
}

export type GrantBulkDrainResult = { jobs: number; acted: number; finished: number };
export type GrantBulkPurgeResult = { jobs: number; outcomes: number };

/** Ended jobs purged per call: each is two deletes of up to 100 000 rows, so a backlog drains over ticks. */
const PURGE_JOBS_PER_CALL = 5;
/** A bulk by id's outcome rows deleted per call, by age. */
const PURGE_OUTCOMES_PER_CALL = 5_000;
const DAY_MS = 86_400_000;

/**
 * One batch of every running bulk job (F-311-u2), asked by `worker-service`'s
 * `grant_bulk_job_drain` tick over the internal seam — the clock is the
 * worker's, the work is here, as `purge-due` (ADR-0027).
 *
 * The scan is cross-tenant: at most `GRANT_BULK_JOB_BATCH_SIZE` pending items,
 * oldest job first. Each Grant is then acted on **in its job's tenant**, as
 * the job's admin — `actOnce`, the bulk by id's own act, so it is audited and
 * told as one admin's act on one Grant, and kept once under the job's
 * `requestId`. A job cancelled since the scan is skipped; one whose last item
 * got its outcome is `done`.
 *
 * **Safe to run twice** (ADR-0027): an item is marked done only where it was
 * not, and `actOnce` answers a stored outcome rather than acting again — two
 * drains racing on one item act on its Grant once.
 *
 * A started job finishes whatever its tenant's status, as a started campaign
 * does (F-018-p): starting it was the `staffWrite`; cancelling is the stop.
 */
@Injectable()
export class GrantBulkJobDrainService {
  private readonly logger = new Logger(GrantBulkJobDrainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async drain(now: Date = new Date()): Promise<GrantBulkDrainResult> {
    const take = this.config.get('GRANT_BULK_JOB_BATCH_SIZE', { infer: true });
    const pending = await this.crossTenant.grantBulkJobItem.findMany({
      where: { doneAt: null, job: { status: GrantBulkJobStatus.running } },
      orderBy: [{ job: { createdAt: 'asc' } }, { grantId: 'asc' }],
      take,
      select: { jobId: true, tenantId: true, grantId: true, attempts: true },
    });
    const jobIds = [...new Set(pending.map((i) => i.jobId))];
    const jobs = await this.crossTenant.grantBulkJob.findMany({ where: { id: { in: jobIds } } });

    let acted = 0;
    let finished = 0;
    for (const job of jobs) {
      const items = pending.filter((i) => i.jobId === job.id);
      const done = await runWithTenant({ id: job.tenantId }, () => this.drainJob(job, items, now));
      acted += done.acted;
      if (done.finished) finished += 1;
    }
    if (acted > 0) this.logger.log(`acted on ${acted} Grant(s) over ${jobs.length} bulk job(s), ${finished} finished`);
    return { jobs: jobs.length, acted, finished };
  }

  /**
   * The retention clock (F-311-u3, user 2026-09-28): `GRANT_BULK_RETENTION_DAYS`
   * (30) after a job ended — done or cancelled, never running — its items and
   * its `grant_bulk_outcome` rows are deleted and `purgedAt` set. **The job row
   * stays**, counts and all: the list still shows it, the audit rows still name
   * it, and a repeat of its `requestId` still answers it and acts on nothing.
   *
   * A bulk by id's outcomes have no job: they go by their own age, and only
   * those whose `requestId` names no job, so a long job's early outcomes are
   * never taken before the job is. A repeat of such a request after 30 days
   * acts again — nobody retries a click a month later.
   *
   * Bounded per call and safe to run twice: a purged job is not due again, and
   * a deleted row is not found again.
   */
  async purge(now: Date = new Date()): Promise<GrantBulkPurgeResult> {
    const cutoff = new Date(now.getTime() - this.config.get('GRANT_BULK_RETENTION_DAYS', { infer: true }) * DAY_MS);
    const due = await this.crossTenant.grantBulkJob.findMany({
      where: { purgedAt: null, finishedAt: { lt: cutoff } },
      orderBy: { finishedAt: 'asc' },
      take: PURGE_JOBS_PER_CALL,
      select: { id: true, tenantId: true, requestId: true },
    });
    for (const job of due) {
      await runWithTenant({ id: job.tenantId }, () =>
        tenantTransaction(this.prisma, async (tx) => {
          await tx.grantBulkJobItem.deleteMany({ where: { jobId: job.id } });
          await tx.grantBulkOutcome.deleteMany({ where: { tenantId: job.tenantId, requestId: job.requestId } });
          await tx.grantBulkJob.updateMany({ where: { id: job.id, purgedAt: null }, data: { purgedAt: now } });
        }),
      );
    }
    const outcomes = await this.crossTenant.$executeRaw`
      DELETE FROM "billing"."grant_bulk_outcome"
       WHERE ctid IN (
         SELECT o.ctid FROM "billing"."grant_bulk_outcome" o
          WHERE o."createdAt" < ${cutoff}
            AND NOT EXISTS (SELECT 1 FROM "billing"."grant_bulk_job" j WHERE j."tenantId" = o."tenantId" AND j."requestId" = o."requestId")
          LIMIT ${PURGE_OUTCOMES_PER_CALL})`;
    if (due.length + outcomes > 0) this.logger.log(`purged ${due.length} ended bulk job(s) and ${outcomes} bulk-by-id outcome(s)`);
    return { jobs: due.length, outcomes };
  }

  /** One job's share of the batch, in its tenant. */
  private async drainJob(job: GrantBulkJob, items: { grantId: string; attempts: number }[], now: Date): Promise<{ acted: number; finished: boolean }> {
    const still = await tenantTransaction(this.prisma, (tx) => tx.grantBulkJob.findFirst({ where: { id: job.id, status: GrantBulkJobStatus.running }, select: { id: true } }));
    if (!still) return { acted: 0, finished: false };

    const actor = { userId: job.actorUserId, ip: job.actorIp };
    const command = job.command as GrantBulkCommand;
    const counts = { okCount: 0, refusedCount: 0, failedCount: 0 };
    let acted = 0;
    for (const item of items) {
      const row = { tenantId: job.tenantId, requestId: job.requestId, grantId: item.grantId, fingerprint: job.fingerprint, actorUserId: job.actorUserId };
      const outcome = await actOnce(this.prisma, actor, command, row);
      acted += 1;
      const failed = 'reason' in outcome && outcome.reason === GRANT_BULK_FAILED;
      const where = { jobId: job.id, grantId: item.grantId, doneAt: null };
      if (failed && item.attempts + 1 < GRANT_BULK_JOB_ATTEMPTS) {
        await tenantTransaction(this.prisma, (tx) => tx.grantBulkJobItem.updateMany({ where, data: { attempts: { increment: 1 } } }));
        continue;
      }
      const { count } = await tenantTransaction(this.prisma, (tx) =>
        tx.grantBulkJobItem.updateMany({ where, data: { attempts: { increment: 1 }, doneAt: now, ok: outcome.ok, failed } }),
      );
      if (count === 0) continue; // another drain marked it; its counts are its own
      if (failed) counts.failedCount += 1;
      else if (outcome.ok) counts.okCount += 1;
      else counts.refusedCount += 1;
    }

    return tenantTransaction(this.prisma, async (tx) => {
      await tx.grantBulkJob.update({
        where: { id: job.id },
        data: { okCount: { increment: counts.okCount }, refusedCount: { increment: counts.refusedCount }, failedCount: { increment: counts.failedCount } },
      });
      const left = await tx.grantBulkJobItem.count({ where: { jobId: job.id, doneAt: null } });
      if (left > 0) return { acted, finished: false };
      const { count } = await tx.grantBulkJob.updateMany({ where: { id: job.id, status: GrantBulkJobStatus.running }, data: { status: GrantBulkJobStatus.done, finishedAt: now } });
      return { acted, finished: count > 0 };
    });
  }
}
