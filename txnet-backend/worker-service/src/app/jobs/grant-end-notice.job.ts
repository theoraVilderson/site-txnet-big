import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const END_DUE_PATH = '/api/internal/billing/entitlement/end-due';
const END_COUNTS = ['scanned', 'told'] as const;

/**
 * The clock on time thresholds (F-601-e, spec 9.5): an active Grant 7, 3 and
 * 1 day(s) before its end. Billing decides and emits
 * (`entitlement/end-notice.ts`); the retention consumer tells. The clock is
 * this service's, over the internal seam, as `grant-unused-notice.job.ts` is.
 *
 * **Hourly**: the shortest gap is a day, and the text carries the days
 * actually left, so a notice an hour late is still true.
 *
 * **Safe to run twice** (ADR-0027): each check sets the Grant's clock
 * conditionally on the one it read, so a redelivered tick finds nothing.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class GrantEndNoticeJob implements Job {
  readonly key = 'grant_end_notice';
  readonly name = 'Service ending soon';
  readonly description =
    'Tells the owner of an active Grant 7, 3 and 1 day(s) before it ends how long is left, once each per end (F-601-e).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, nobody is told their service is ending. Hourly, at fifty past. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '50 * * * *' };

  private readonly logger = new Logger(GrantEndNoticeJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not boot, for the reason `vault-retention.job.ts` gives.
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.endDue();
    if (result.told > 0) this.logger.log(`told ${result.told} of ${result.scanned} due Grant(s) their end is near`);
    return { itemsProcessed: result.told, errorsCount: 0, metrics: { ...result } };
  }

  private async endDue(): Promise<Record<(typeof END_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${END_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${END_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = END_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${END_DUE_PATH} without its ${END_COUNTS.length} counts`);
      const [scanned, told] = counts as number[];
      return { scanned, told };
    } finally {
      clearTimeout(timer);
    }
  }
}
