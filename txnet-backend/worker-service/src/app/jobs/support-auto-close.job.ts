import { serviceCallHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const CLOSE_IDLE_PATH = '/api/internal/support/close-idle';

/**
 * The clock on closing idle support threads (F-033-k).
 *
 * A thread waiting on its user, or resolved, with no word from them for the
 * tenant's days (the platform's 7 by default) is closed by support-service
 * (`lifecycle/lifecycle.ts`). The rule is support's and the clock is this
 * service's, over the internal seam, as `lottery-close.job.ts` does.
 *
 * **Every 15 minutes**: the threshold is days, so a quarter hour late is
 * nothing, and an idle tick is one indexed query.
 *
 * **Safe to run twice**: each close re-checks the thread under its row lock.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class SupportAutoCloseJob implements Job {
  readonly key = 'support_auto_close';
  readonly name = 'Support auto-close';
  readonly description =
    "Closes every support conversation waiting on its user, or resolved, with no word from the user for the tenant's auto-close days — 7 unless the tenant set its own (F-033-k).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, no thread ever closes by itself. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/15 * * * *' };

  private readonly logger = new Logger(SupportAutoCloseJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('SUPPORT_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('SUPPORT_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not boot, for the reason `vault-retention.job.ts` gives.
    if (!this.baseUrl) throw new Error('SUPPORT_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const response = await fetch(`${this.baseUrl}${CLOSE_IDLE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
      body: '{}',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`support answered ${response.status} to ${CLOSE_IDLE_PATH}`);
    const body = envelopeData(await response.json());
    const scanned = body?.scanned;
    const closed = body?.closed;
    if (typeof scanned !== 'number' || typeof closed !== 'number') throw new Error(`support answered ${CLOSE_IDLE_PATH} without its counts`);

    if (closed > 0) this.logger.log(`closed ${closed} idle support conversation(s) of ${scanned} due`);
    return { itemsProcessed: closed, errorsCount: 0, metrics: { scanned, closed } };
  }
}
