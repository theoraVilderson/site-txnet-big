import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DRAIN_PATH = '/api/internal/billing/grant-bulk-jobs/drain';

/**
 * A reseller's bulk act by filter, acted on in batches (F-311-u2) — e.g. +3
 * days to every active Grant on the panel that was down.
 *
 * **The work is billing's and the clock is this service's** — the same split
 * as `grant-purge.job.ts` (ADR-0027). The job's frozen Grants, each act, its
 * audit row and its notice all live in `billing-service`, which an Nx
 * application cannot import, so this asks over the internal seam.
 *
 * **Resumable and safe to run twice.** One call acts on a bounded batch
 * (`GRANT_BULK_JOB_BATCH_SIZE`) and answers; the items it marked done are
 * where the next tick starts, and a Grant already acted on under the job's
 * `requestId` is answered, not acted on again (F-311-u1).
 *
 * **It never succeeds quietly**, for the reason `vault-retention.job.ts` gives.
 */
@Injectable()
export class GrantBulkJobDrainJob implements Job {
  readonly key = 'grant_bulk_job_drain';
  readonly name = 'Bulk Grant actions';
  readonly description = "Acts on the next batch of every running bulk job a reseller's admin started by a filter (F-311-u2).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a started job stays `running` with no Grant acted on. An idle tick is one query. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };
  /**
   * A started job finishes whatever its tenant's status, as a started campaign
   * does (F-018-p): only starting one is a `staffWrite`; cancelling is the stop.
   */
  readonly tenantCapability = 'system' as const;

  private readonly logger = new Logger(GrantBulkJobDrainJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${DRAIN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${DRAIN_PATH}`);

      const body = envelopeData(await response.json());
      const keys = ['jobs', 'acted', 'finished'] as const;
      if (!keys.every((k) => typeof body?.[k] === 'number')) {
        throw new Error(`billing answered ${DRAIN_PATH} without its three counts`);
      }
      const [jobs, acted, finished] = keys.map((k) => body![k] as number);
      if (acted > 0) this.logger.log(`acted on ${acted} Grant(s) over ${jobs} bulk job(s), ${finished} finished`);
      return { itemsProcessed: acted, errorsCount: 0, metrics: { jobs, acted, finished } };
    } finally {
      clearTimeout(timer);
    }
  }
}
