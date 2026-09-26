import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The route this job exists to call. Service callers only; 404 otherwise. */
const SWEEP_DUE_PATH = '/api/internal/billing/network/hot-loop/sweep-due';
const SWEEP_COUNTS = ['scanned', 'rebalanced', 'bought', 'raced', 'failed'] as const;

/**
 * The clock on the hot loop's sweep (F-027-cn, network `contract.hot-loop.md`).
 *
 * The delta stream calls the hot loop for every Grant a collection pass
 * carried a delta for (F-027-cl). A config the panel cut off at its own share
 * carries none, and with its Grant's other configs idle nothing calls it, so
 * its bag stays split with bytes unspent. The work is billing-service's
 * behind the internal seam, like `grant-group-fulfilment.job.ts`'s; this job
 * holds only *when*.
 *
 * **Every minute.** A cut-off user waits on it; the scan names only Grants
 * with a split still to move, so an idle tick is one query.
 *
 * **Safe to run twice** (ADR-0027): once re-split, the config's share is
 * above what it served and the scan no longer names it.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class HotLoopSweepJob implements Job {
  readonly key = 'hot_loop_sweep';
  readonly name = 'Hot loop sweep';
  readonly description =
    "Re-splits the bag of each active Grant with bytes left and a config cut off at its own share, which no delta names (F-027-cn).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a config cut off beside an idle one stays cut off. Every minute: the user is waiting. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '* * * * *' };

  private readonly logger = new Logger(HotLoopSweepJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not at boot (`vault-retention.job.ts`).
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.ask();
    if (result.rebalanced > 0 || result.bought > 0) {
      this.logger.log(`re-split ${result.rebalanced}, bought for ${result.bought} of ${result.scanned} Grant(s)`);
    }
    return { itemsProcessed: result.rebalanced + result.bought, errorsCount: result.failed, metrics: result };
  }

  private async ask(): Promise<Record<(typeof SWEEP_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${SWEEP_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      // 404 is the guard's answer to a caller it does not recognise.
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${SWEEP_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = SWEEP_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${SWEEP_DUE_PATH} without its ${SWEEP_COUNTS.length} counts`);
      return Object.fromEntries(SWEEP_COUNTS.map((k, i) => [k, counts[i] as number])) as Record<(typeof SWEEP_COUNTS)[number], number>;
    } finally {
      clearTimeout(timer);
    }
  }
}
