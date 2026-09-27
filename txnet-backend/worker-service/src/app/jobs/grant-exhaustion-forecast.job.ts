import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const FORECAST_DUE_PATH = '/api/internal/billing/entitlement/forecast-due';
const FORECAST_COUNTS = ['scanned', 'told'] as const;

/**
 * The clock on the exhaustion forecast (F-602, spec 9.5): "at this rate, your
 * volume runs out in N days". Billing decides and emits
 * (`entitlement/exhaustion-forecast.ts`); the retention consumer tells. The
 * clock is this service's, over the internal seam, as `grant-purge.job.ts` is.
 *
 * **Hourly**: a 5-day horizon read an hour late costs nothing.
 *
 * **Safe to run twice** (ADR-0027): each told Grant marks its usage period
 * conditionally on the value it read, so a redelivered tick tells no one twice.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class GrantExhaustionForecastJob implements Job {
  readonly key = 'grant_exhaustion_forecast';
  readonly name = 'Volume runs out soon';
  readonly description =
    'Tells the owner of a prepaid Grant, once per usage period, when its last 72 h of usage spend what is left within 5 days (F-602).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, nobody is warned before their volume runs out. Hourly, at a quarter to. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '45 * * * *' };

  private readonly logger = new Logger(GrantExhaustionForecastJob.name);
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

    const result = await this.forecastDue();
    if (result.told > 0) this.logger.log(`forecast exhaustion for ${result.told} of ${result.scanned} Grant(s)`);
    return { itemsProcessed: result.told, errorsCount: 0, metrics: { ...result } };
  }

  private async forecastDue(): Promise<Record<(typeof FORECAST_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${FORECAST_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${FORECAST_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = FORECAST_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${FORECAST_DUE_PATH} without its ${FORECAST_COUNTS.length} counts`);
      const [scanned, told] = counts as number[];
      return { scanned, told };
    } finally {
      clearTimeout(timer);
    }
  }
}
