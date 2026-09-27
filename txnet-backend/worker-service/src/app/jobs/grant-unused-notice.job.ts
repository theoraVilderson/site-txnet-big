import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const UNUSED_DUE_PATH = '/api/internal/billing/entitlement/unused-due';
const UNUSED_COUNTS = ['scanned', 'told'] as const;

/**
 * The clock on "not connected yet?" (F-601-c, spec 9.5): an active Grant with
 * nothing consumed 24 h and again 72 h after activation. Billing decides and
 * emits (`entitlement/unused-notice.ts`); the retention consumer tells. The
 * clock is this service's, over the internal seam, as `grant-purge.job.ts` is.
 *
 * **Hourly**: the asks are a day apart, so one an hour late costs nothing.
 *
 * **Safe to run twice** (ADR-0027): each check moves or clears the Grant's
 * clock conditionally on the one it read, so a redelivered tick finds nothing.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class GrantUnusedNoticeJob implements Job {
  readonly key = 'grant_unused_notice';
  readonly name = 'Not connected yet?';
  readonly description =
    'Asks the owner of an active Grant that consumed nothing 24 h, and again 72 h, after activation whether they connected, with the steps and support (F-601-c).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, nobody who bought and never connected is asked. Hourly, at forty past. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '40 * * * *' };

  private readonly logger = new Logger(GrantUnusedNoticeJob.name);
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

    const result = await this.unusedDue();
    if (result.told > 0) this.logger.log(`asked ${result.told} of ${result.scanned} due Grant(s) whether they connected`);
    return { itemsProcessed: result.told, errorsCount: 0, metrics: { ...result } };
  }

  private async unusedDue(): Promise<Record<(typeof UNUSED_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${UNUSED_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${UNUSED_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = UNUSED_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${UNUSED_DUE_PATH} without its ${UNUSED_COUNTS.length} counts`);
      const [scanned, told] = counts as number[];
      return { scanned, told };
    } finally {
      clearTimeout(timer);
    }
  }
}
