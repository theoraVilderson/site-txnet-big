import { serviceCallHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const SWEEP_PATH = '/api/internal/guides/file-sweep';

/**
 * The clock on unused guide files (F-414-m, ADR-0120 point 3).
 *
 * tenant-service (`guide/guide-file-sweep.ts`) deletes a guide file 7 days
 * after upload when no published text and no draft of any tenant names it.
 * The rule is the guide unit's and the clock is this service's, as
 * `support-retention.job.ts` does.
 *
 * **Nightly**, after support's retention. **Safe to run twice**: a file
 * already gone is skipped. **It never succeeds quietly**: an unset seam, a 404,
 * an unreadable text (tenant-service then sweeps nothing and answers 500) and
 * an answer without its counts each throw, so `TickConsumer` records a
 * `failed` run (automation invariant #3).
 */
@Injectable()
export class GuideFileSweepJob implements Job {
  readonly key = 'guide_file_sweep';
  readonly name = 'Guide file sweep';
  readonly description =
    'Deletes guide images and videos 7 days after upload when no published text or draft of any tenant names them (F-414-m, ADR-0120).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, an unused upload is kept for ever and counts against its reseller's storage quota. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '15 4 * * *' };

  private readonly logger = new Logger(GuideFileSweepJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('TENANT_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('TENANT_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const response = await fetch(`${this.baseUrl}${SWEEP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`tenant-service answered ${response.status} to ${SWEEP_PATH}`);
    const body = envelopeData(await response.json());
    const { scanned, deleted, bytes } = body ?? {};
    if (typeof scanned !== 'number' || typeof deleted !== 'number' || typeof bytes !== 'number') {
      throw new Error(`tenant-service answered ${SWEEP_PATH} without its counts`);
    }

    if (deleted > 0) this.logger.log(`swept ${deleted} unused guide file(s), ${bytes} bytes`);
    return { itemsProcessed: deleted, errorsCount: 0, metrics: { scanned, deleted, bytes } };
  }
}
