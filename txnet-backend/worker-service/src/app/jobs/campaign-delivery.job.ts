import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DELIVER_PATH = '/api/internal/notifications/campaigns/deliver';

/**
 * Queued campaign recipients go out on Telegram and Bale (F-035-e).
 *
 * The fan-out job's twin (`campaign-fan-out.job.ts` has the why of the split):
 * the rows, the claim and the sends are `notification-service`'s, the clock is
 * this service's. One call sends a bounded number of rows and answers.
 *
 * **Safe to run twice.** A run claims rows under a lease that an overlapping
 * run skips (notification invariant 4).
 *
 * `stalled` is the error count: rows left queued because a tenant's bot could
 * not be resolved or its token read, which no retry fixes until an operator
 * does. A rate limit (`deferred`) is not an error — it is the platform pacing.
 */
@Injectable()
export class CampaignDeliveryJob implements Job {
  readonly key = 'notification_campaign_delivery';
  readonly name = 'Campaign delivery';
  readonly description =
    'Sends queued campaign recipients through their tenant\'s Telegram or Bale bot, in bounded runs (F-035-e).';
  readonly category = BotWorkerCategory.campaign;
  /**
   * A started campaign finishes whatever its tenant's status (F-018-p, user
   * 2026-09-17): only starting one is a `staffWrite`. Declared for the day a
   * tick names the tenant; today's ticks are platform sweeps.
   */
  readonly tenantCapability = 'system' as const;

  private readonly logger = new Logger(CampaignDeliveryJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('NOTIFICATION_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('NOTIFICATION_API_TIMEOUT_MS', 60_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('NOTIFICATION_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${DELIVER_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification answered ${response.status} to ${DELIVER_PATH}`);

      const body = envelopeData(await response.json());
      const keys = ['claimed', 'sent', 'failed', 'deferred', 'stalled'] as const;
      if (!keys.every((k) => typeof body?.[k] === 'number')) {
        throw new Error(`notification answered ${DELIVER_PATH} without its five counts`);
      }
      const [claimed, sent, failed, deferred, stalled] = keys.map((k) => body![k] as number);
      if (claimed > 0) this.logger.log(`claimed ${claimed}: ${sent} sent, ${failed} failed, ${deferred} deferred`);
      if (stalled > 0) this.logger.error(`${stalled} recipient(s) stalled — a tenant's bot or its token is unavailable`);
      return { itemsProcessed: sent + failed, errorsCount: stalled, metrics: { claimed, sent, failed, deferred, stalled } };
    } finally {
      clearTimeout(timer);
    }
  }
}
