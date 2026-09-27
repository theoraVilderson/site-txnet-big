import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const IDLE_DUE_PATH = '/api/internal/billing/entitlement/idle-due';
const IDLE_COUNTS = ['scanned', 'told'] as const;

/**
 * The clock on "trouble connecting?" (F-601-l, spec 9.5): an active Grant
 * that was used and then consumed nothing for 7 days. Billing decides and
 * emits (`entitlement/idle-notice.ts`); the retention consumer tells. The
 * clock is this service's, over the internal seam, as `grant-purge.job.ts` is.
 *
 * **Hourly**: a week's silence an hour later costs nothing.
 *
 * **Safe to run twice** (ADR-0027): each check clears the Grant's clock
 * conditionally on the one it read, so a redelivered tick finds nothing.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class GrantIdleNoticeJob implements Job {
  readonly key = 'grant_idle_notice';
  readonly name = 'Trouble connecting?';
  readonly description =
    'Checks in once on the owner of an active Grant that was used and then consumed nothing for 7 days, with the reconnect steps and support (F-601-l).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, nobody whose service went quiet is asked. Hourly, at half past. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '30 * * * *' };

  private readonly logger = new Logger(GrantIdleNoticeJob.name);
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

    const result = await this.idleDue();
    if (result.told > 0) this.logger.log(`checked in on ${result.told} of ${result.scanned} idle Grant(s)`);
    return { itemsProcessed: result.told, errorsCount: 0, metrics: { ...result } };
  }

  private async idleDue(): Promise<Record<(typeof IDLE_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${IDLE_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${IDLE_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = IDLE_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${IDLE_DUE_PATH} without its ${IDLE_COUNTS.length} counts`);
      const [scanned, told] = counts as number[];
      return { scanned, told };
    } finally {
      clearTimeout(timer);
    }
  }
}
