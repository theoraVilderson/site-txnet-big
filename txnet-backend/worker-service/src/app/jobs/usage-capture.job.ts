import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const CAPTURE_DUE_PATH = '/api/internal/billing/usage/capture-due';
const CAPTURE_COUNTS = ['scanned', 'captured', 'errors'] as const;

/**
 * The clock on postpaid usage (F-118-g, ADR-0105 (6)): every active postpaid
 * meter's measured usage is captured from its hold, and the hold put back to
 * its target. Billing decides and moves the money (`usage/usage-settlement.ts`);
 * the clock is this service's, over the internal seam, as
 * `grant-idle-notice.job.ts` is.
 *
 * **Hourly** (billing open-questions 2026-09-29): a capture also runs before
 * every re-top and at close, so the hour only bounds how long measured usage
 * sits held rather than charged.
 *
 * **Safe to run twice** (ADR-0027): a capture moves the meter's `billed`
 * cursor to what it charged, so a redelivered tick finds nothing due.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class UsageCaptureJob implements Job {
  readonly key = 'usage_capture';
  readonly name = 'Postpaid usage capture';
  readonly description =
    'Charges the measured usage of every active postpaid meter from the money held for it, and tops the hold back up (F-118-g).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, measured usage stays held and uncharged until the Grant closes. Hourly, at five past. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '5 * * * *' };

  private readonly logger = new Logger(UsageCaptureJob.name);
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

    const result = await this.captureDue();
    if (result.captured > 0) this.logger.log(`captured usage on ${result.captured} of ${result.scanned} postpaid meter(s)`);
    return { itemsProcessed: result.captured, errorsCount: result.errors, metrics: { ...result } };
  }

  private async captureDue(): Promise<Record<(typeof CAPTURE_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${CAPTURE_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${CAPTURE_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = CAPTURE_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${CAPTURE_DUE_PATH} without its ${CAPTURE_COUNTS.length} counts`);
      const [scanned, captured, errors] = counts as number[];
      return { scanned, captured, errors };
    } finally {
      clearTimeout(timer);
    }
  }
}
