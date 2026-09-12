import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const EXPIRE_PENDING_PATH = '/api/internal/billing/deposit/expire-pending';

/**
 * The clock on an abandoned top-up (F-092-k).
 *
 * A `pending` payment holds a slot of every coupon it applied. A payer who
 * closes the tab at the bank never comes back, so nothing settles it and
 * nothing releases them — legacy let two Mongo TTL indexes delete the payment
 * and its locks on separate clocks, which lost the attempt from the audit trail
 * and could still outlive it. This is the replacement: the row stays, its
 * status becomes `expired`, and its holds go back.
 *
 * **The work is billing's and the clock is this service's.** Deciding what an
 * expired payment is means the coupon reservation functions, the tenant-scoped
 * pool and the cross-tenant one — all of them inside `billing-service`, which
 * an Nx application cannot import. So this asks over the internal seam, exactly
 * as `vault-retention.job.ts` does, and holds only `SERVICE_AUTH_TOKEN`.
 *
 * **Safe to run twice** (the `Job` contract, ADR-0027): the flip on the other
 * side is guarded by the row's own status, so a redelivered tick expires
 * nothing and answers zero.
 *
 * **It never succeeds quietly.** A missing seam, a guard's 404 and an answer in
 * a shape this does not recognise are each indistinguishable from "nothing was
 * due" if the run reports zero and success — and this is precisely the kind of
 * job nobody looks at while it is working. Each one throws, and `TickConsumer`
 * records a `failed` run (automation invariant #3).
 *
 * `unattributed` is carried into the metrics rather than being treated as an
 * error here: it is a schema fault billing logs and no retry of this job can
 * change, and failing the run would hide every sweep that did work.
 */
@Injectable()
export class DepositExpiryJob implements Job {
  readonly key = 'deposit_pending_expiry';
  readonly name = 'Pending top-up expiry';
  readonly description =
    'Expires pending payments past their expiresAt and releases the coupon holds they took (F-092-k).';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(DepositExpiryJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not at boot, for the reason `vault-retention.job.ts`
    // gives: this service holds no credential of its own and must boot without
    // one, so an unconfigured seam fails *this job's run* and leaves the rest
    // of the queue draining.
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.expirePending();
    if (result.expired > 0) {
      this.logger.log(`expired ${result.expired} pending payment(s) of ${result.scanned} due`);
    }
    if (result.unattributed > 0) {
      this.logger.error(
        `${result.unattributed} due payment(s) carry no tenant and cannot be expired — billing has the ids`,
      );
    }
    return {
      itemsProcessed: result.expired,
      errorsCount: result.unattributed,
      metrics: { ...result },
    };
  }

  private async expirePending(): Promise<{ scanned: number; expired: number; unattributed: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${EXPIRE_PENDING_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        body: '{}',
        signal: controller.signal,
      });

      if (!response.ok) {
        // 404 is the guard's answer to a caller it does not recognise, which is
        // the shape a rotated-away `SERVICE_AUTH_TOKEN` takes here. It is
        // deliberately indistinguishable from a route that does not exist, so
        // the message says what was asked rather than why it was refused.
        throw new Error(`billing answered ${response.status} to ${EXPIRE_PENDING_PATH}`);
      }

      const body: unknown = await response.json();
      const counts = ['scanned', 'expired', 'unattributed'].map((k) => (body as Record<string, unknown>)?.[k]);
      if (!counts.every((v) => typeof v === 'number')) {
        throw new Error(`billing answered ${EXPIRE_PENDING_PATH} without its three counts`);
      }
      const [scanned, expired, unattributed] = counts as number[];
      return { scanned, expired, unattributed };
    } finally {
      clearTimeout(timer);
    }
  }
}
