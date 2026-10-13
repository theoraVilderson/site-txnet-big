import { serviceCallHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const WRITE_PATH = '/api/internal/catalog/seasons/write-upcoming';

/**
 * Writes every tenant's season occurrences due within 14 days as campaign
 * prices (F-505-b; catalog F-505-a — Nowruz, Yalda, Thursday night, each a
 * campaign of two price rows, never an overwrite). billing-service decides
 * what is due and writes each once; a refused one (a plain price scheduled
 * inside it, an overlap) is counted as this run's error, never silent.
 *
 * **Hourly**: a season or a price set today is written within the hour, and
 * a run missed is made up by the next — the horizon is two weeks. A platform
 * tick (no `tenantId`). An unset seam, a refusal or an answer without its
 * counts throws.
 */
@Injectable()
export class CatalogSeasonWriteJob implements Job {
  readonly key = 'catalog_season_write';
  readonly name = 'Season prices';
  readonly description = "Writes every tenant's coming season occurrences as campaign prices, 14 days ahead (F-505-b).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, no season price is ever written: Nowruz would come at the full price. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '20 * * * *' };

  private readonly logger = new Logger(CatalogSeasonWriteJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 60_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${WRITE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...serviceCallHeaders(this.serviceToken) },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing-api answered ${response.status} to ${WRITE_PATH}`);
      const data = envelopeData(await response.json());
      if (typeof data?.due !== 'number' || typeof data?.written !== 'number' || typeof data?.refused !== 'number') {
        throw new Error(`billing-api answered ${WRITE_PATH} without its counts`);
      }
      if (data.written > 0 || data.refused > 0) this.logger.log(`season prices: ${data.written} written, ${data.refused} refused`);
      return { itemsProcessed: data.written, errorsCount: data.refused, metrics: { due: data.due, written: data.written, refused: data.refused } };
    } finally {
      clearTimeout(timer);
    }
  }
}
