import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const FAN_OUT_PATH = '/api/internal/notifications/campaigns/fan-out';

/**
 * A started campaign becomes recipient rows (F-035-d).
 *
 * **The work is notification's and the clock is this service's** — the same
 * split as `deposit-expiry.job.ts`. The audience query, the cross-tenant pool
 * and the rows all live in `notification-service` (ADR-0052), which an Nx
 * application cannot import, so this asks over the internal seam.
 *
 * **Resumable and safe to run twice.** One call writes a bounded number of rows
 * and answers; the cursor it committed is where the next tick starts, and a
 * replayed batch inserts nothing (notification invariant 4).
 *
 * **It never succeeds quietly**, for the reason `vault-retention.job.ts` gives.
 * A campaign whose stored audience does not parse is counted as an error rather
 * than failing the run: no retry changes it, and failing would hide the
 * campaigns that did fan out.
 */
@Injectable()
export class CampaignFanOutJob implements Job {
  readonly key = 'notification_campaign_fan_out';
  readonly name = 'Campaign fan-out';
  readonly description =
    'Writes one queued recipient row per user of every started campaign, in resumable batches (F-035-d).';
  readonly category = BotWorkerCategory.campaign;

  private readonly logger = new Logger(CampaignFanOutJob.name);
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
      const response = await fetch(`${this.baseUrl}${FAN_OUT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification answered ${response.status} to ${FAN_OUT_PATH}`);

      const body = envelopeData(await response.json());
      const keys = ['campaigns', 'recipients', 'finished', 'unreadable'] as const;
      if (!keys.every((k) => typeof body?.[k] === 'number')) {
        throw new Error(`notification answered ${FAN_OUT_PATH} without its four counts`);
      }
      const [campaigns, recipients, finished, unreadable] = keys.map((k) => body![k] as number);
      if (recipients > 0) this.logger.log(`wrote ${recipients} recipient(s) over ${campaigns} campaign(s), ${finished} finished`);
      if (unreadable > 0) this.logger.error(`${unreadable} started campaign(s) have no readable audience — notification has the ids`);
      return { itemsProcessed: recipients, errorsCount: unreadable, metrics: { campaigns, recipients, finished, unreadable } };
    } finally {
      clearTimeout(timer);
    }
  }
}
