import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const REBUILD_PATH = '/api/internal/ai/profiles/rebuild';
const REBUILD_COUNTS = ['tenants', 'skipped', 'accounts', 'readings', 'purged'] as const;

/**
 * The clock on the revenue engine's profiles (F-038-c, ADR-0109 point 6):
 * every hour, `ai-service` samples each active Grant's meters and rebuilds
 * every account's profile from the database. The rule and both pools are
 * `ai-service`'s; this job owns only *when*, over the internal seam, as
 * `grant-exhaustion-forecast.job.ts` does for billing.
 *
 * **Hourly, at 05**: a reading is keyed by its UTC hour, so the clock decides
 * the resolution of every usage rate the engine predicts from.
 *
 * **Safe to run twice** (ADR-0027): a second run in the same hour adds only
 * what grew since the first.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run.
 */
@Injectable()
export class AiProfileRebuildJob implements Job {
  readonly key = 'ai_profile_rebuild';
  readonly name = 'AI profiles';
  readonly description =
    'Samples every active Grant\'s meters and rebuilds each account\'s AI profile from the last 180 days (F-038-c).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, the engine has no usage rate and no active hours. Hourly, five past. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '5 * * * *' };

  private readonly logger = new Logger(AiProfileRebuildJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('AI_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AI_API_TIMEOUT_MS', 300_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('AI_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.rebuild();
    this.logger.log(`rebuilt ${result.accounts} profile(s) in ${result.tenants} tenant(s)`);
    return { itemsProcessed: result.accounts, errorsCount: 0, metrics: { ...result } };
  }

  private async rebuild(): Promise<Record<(typeof REBUILD_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${REBUILD_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`ai-service answered ${response.status} to ${REBUILD_PATH}`);

      const body = envelopeData(await response.json());
      const counts = REBUILD_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`ai-service answered ${REBUILD_PATH} without its ${REBUILD_COUNTS.length} counts`);
      return Object.fromEntries(REBUILD_COUNTS.map((k, i) => [k, counts[i]])) as Record<(typeof REBUILD_COUNTS)[number], number>;
    } finally {
      clearTimeout(timer);
    }
  }
}
