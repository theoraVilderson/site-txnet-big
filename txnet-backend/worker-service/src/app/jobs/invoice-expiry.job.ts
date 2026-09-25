import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const EXPIRE_PENDING_PATH = '/api/internal/billing/invoices/expire-pending';

/**
 * The 30-minute clock on an invoice nobody paid (F-111-a, spec §5.8).
 *
 * An invoice holds a slot of every coupon it applied; without this, a shopper
 * who closes the page holds it for ever — for themselves and against the
 * code's total. The rule is billing's (`invoice-expiry.service.ts`) and the
 * clock is this service's, over the internal seam, exactly as
 * `deposit-expiry.job.ts` does for a top-up. Safe to run twice: the flip is
 * guarded by the row's own status. An answer it cannot read fails the run
 * rather than reporting zero (automation invariant #3).
 */
@Injectable()
export class InvoiceExpiryJob implements Job {
  readonly key = 'invoice_pending_expiry';
  readonly name = 'Pending invoice expiry';
  readonly description = 'Expires unpaid invoices past their expiresAt and releases the coupon holds they took (F-111-a).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, an abandoned invoice holds its coupons for ever (the user's call, 2026-09-25). */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };

  private readonly logger = new Logger(InvoiceExpiryJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not boot, for the reason `deposit-expiry.job.ts` gives.
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.expirePending();
    if (result.expired > 0) this.logger.log(`expired ${result.expired} pending invoice(s) of ${result.scanned} due`);
    return { itemsProcessed: result.expired, errorsCount: 0, metrics: { ...result } };
  }

  private async expirePending(): Promise<{ scanned: number; expired: number; holdsReleased: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${EXPIRE_PENDING_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${EXPIRE_PENDING_PATH}`);

      const body = envelopeData(await response.json());
      const counts = ['scanned', 'expired', 'holdsReleased'].map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) {
        throw new Error(`billing answered ${EXPIRE_PENDING_PATH} without its three counts`);
      }
      const [scanned, expired, holdsReleased] = counts as number[];
      return { scanned, expired, holdsReleased };
    } finally {
      clearTimeout(timer);
    }
  }
}
