import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const CLOSE_DUE_PATH = '/api/internal/billing/engagement/lotteries/close-due';
const CLOSE_COUNTS = ['scanned', 'frozen', 'failed'] as const;

/**
 * The clock on closing a lottery (F-707-k, ADR-0111 point 5).
 *
 * A published lottery past its `closesAt` is frozen by billing — the entrant
 * list judged and numbered, its hash taken, and only then the seed made and
 * sealed, in one transaction (`engagement/lottery-close.service.ts`). The rule
 * is billing's and the clock is this service's, over the internal seam, as
 * `grant-delivery.job.ts` does. No admin route does this: it is the only way a
 * lottery closes.
 *
 * **Every minute**: users wait on the result, and an idle tick is one indexed
 * query.
 *
 * **Safe to run twice** (ADR-0027): a lottery is taken only while `published`,
 * under its row lock, and its draw row's key is the lottery.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class LotteryCloseJob implements Job {
  readonly key = 'lottery_close';
  readonly name = 'Lottery close';
  readonly description =
    'Freezes every published lottery past its close time: entrants judged and numbered, the list hashed, then the seed made and sealed (F-707-k).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, no lottery ever closes. Every minute: a close is a moment users watch for. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '* * * * *' };

  private readonly logger = new Logger(LotteryCloseJob.name);
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

    const result = await this.closeDue();
    if (result.frozen > 0) this.logger.log(`froze ${result.frozen} of ${result.scanned} lotteries due`);
    return { itemsProcessed: result.frozen, errorsCount: result.failed, metrics: { ...result } };
  }

  private async closeDue(): Promise<Record<(typeof CLOSE_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${CLOSE_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${CLOSE_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = CLOSE_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${CLOSE_DUE_PATH} without its ${CLOSE_COUNTS.length} counts`);
      return Object.fromEntries(CLOSE_COUNTS.map((k, i) => [k, counts[i] as number])) as Record<(typeof CLOSE_COUNTS)[number], number>;
    } finally {
      clearTimeout(timer);
    }
  }
}
