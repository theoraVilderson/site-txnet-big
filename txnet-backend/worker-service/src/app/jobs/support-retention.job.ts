import { serviceCallHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const RETENTION_PATH = '/api/internal/support/retention';

/**
 * The clock on support retention (F-033-n, user 2026-10-04).
 *
 * support-service (`retention/retention.ts`) deletes the files of attachments
 * whose conversation closed more than 90 days ago, and archives then drops
 * every message month older than 12 months. The rule is support's and the clock
 * is this service's, as `support-auto-close.job.ts` does.
 *
 * **Daily, at night**: the thresholds are days and months, and archiving a
 * month is the heaviest write support makes. **Safe to run twice**: an
 * expired file is skipped, a dropped month is no longer listed, and a month
 * whose archive failed is redone whole.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class SupportRetentionJob implements Job {
  readonly key = 'support_retention';
  readonly name = 'Support retention';
  readonly description =
    'Deletes attachment files 90 days after their conversation closed (the row stays, marked expired) and archives each support message month older than 12 months per tenant, then drops it (F-033-n).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, files and messages are kept forever. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '30 3 * * *' };

  private readonly logger = new Logger(SupportRetentionJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('SUPPORT_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('SUPPORT_RETENTION_TIMEOUT_MS', 600_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('SUPPORT_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const response = await fetch(`${this.baseUrl}${RETENTION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`support answered ${response.status} to ${RETENTION_PATH}`);
    const body = envelopeData(await response.json());
    const expired = body?.expired;
    const months = body?.months;
    if (typeof expired !== 'number' || !Array.isArray(months)) throw new Error(`support answered ${RETENTION_PATH} without its counts`);

    if (expired > 0 || months.length > 0) this.logger.log(`expired ${expired} support file(s); archived month(s): ${months.join(', ') || 'none'}`);
    return { itemsProcessed: expired + months.length, errorsCount: 0, metrics: { expired, months: months.length } };
  }
}
