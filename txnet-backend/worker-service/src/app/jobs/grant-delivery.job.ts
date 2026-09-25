import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DELIVER_DUE_PATH = '/api/internal/billing/entitlement/deliver-due';
const DELIVER_COUNTS = ['scanned', 'delivered', 'waiting', 'refunded', 'failed'] as const;

/**
 * The clock on delivering a paid Grant (F-111-d, spec §5.8 step 3).
 *
 * A purchase is issued `pending`; billing checks each one when its
 * `nextDeliveryAt` is due — delivered, pushed to its next retry, or past the
 * last one cancelled and refunded (`entitlement/delivery.ts`). The rule is
 * billing's and the clock is this service's, over the internal seam, as
 * `grant-group-fulfilment.job.ts` does.
 *
 * **Every minute**: the first retry is a minute after the first check, and a
 * buyer waits on it. An idle tick is one indexed query.
 *
 * **Safe to run twice** (ADR-0027): every write is conditional on `pending`,
 * and a checked Grant is not due again until its next retry.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class GrantDeliveryJob implements Job {
  readonly key = 'grant_delivery';
  readonly name = 'Paid Grant delivery';
  readonly description =
    'Delivers paid Grants by fulfilment kind; one still undelivered after its last retry, or of a kind with no handler, is cancelled and its invoice refunded in full (F-111-d).';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(GrantDeliveryJob.name);
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

    const result = await this.deliverDue();
    if (result.delivered > 0 || result.refunded > 0) {
      this.logger.log(`delivered ${result.delivered}, refunded ${result.refunded} of ${result.scanned} paid Grant(s) due`);
    }
    return { itemsProcessed: result.delivered + result.refunded, errorsCount: result.failed, metrics: { ...result } };
  }

  private async deliverDue(): Promise<Record<(typeof DELIVER_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${DELIVER_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${DELIVER_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = DELIVER_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${DELIVER_DUE_PATH} without its ${DELIVER_COUNTS.length} counts`);
      return Object.fromEntries(DELIVER_COUNTS.map((k, i) => [k, counts[i] as number])) as Record<(typeof DELIVER_COUNTS)[number], number>;
    } finally {
      clearTimeout(timer);
    }
  }
}
