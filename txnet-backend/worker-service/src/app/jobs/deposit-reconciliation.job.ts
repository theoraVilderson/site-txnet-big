import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const RECONCILE_PATH = '/api/internal/billing/deposit/reconcile';

/** The counts billing answers with. All five, or the answer is not one this job understands. */
const COUNTS = ['scanned', 'confirmed', 'flagged', 'unchanged', 'errors'] as const;

type ReconciliationCounts = Record<(typeof COUNTS)[number], number>;

/**
 * Going and asking the gateway about payments nobody came back for (F-092-l).
 *
 * The callback settles a payment whose payer returned; the expiry job closes
 * the clock on the ones who did not. This is the third case, and the one the
 * other two deliberately leave open: a payment the gateway **could not be
 * reached about**. F-092-j leaves a verify that timed out `pending` rather than
 * guessing, precisely so that something can ask later — and until this job
 * existed, nothing did.
 *
 * **A separate job from the expiry sweep, not a step inside it.** The two have
 * different costs and want different schedules: expiry reads a clock and calls
 * no gateway, while this makes one call to a bank per payment. Merging them
 * would tie the cheap, frequent one to the rate at which a bank will answer.
 *
 * **`errors` is reported and does not fail the run.** A payment the gateway
 * would not answer about is the normal condition this job is built for, not a
 * fault of the run: billing writes no log row for one, so the next run asks
 * again. What does fail the run is the seam itself — an unset variable, a
 * guard's 404, an answer in a shape this does not recognise — because those are
 * indistinguishable from "nothing was due" and this is a job nobody looks at
 * while it is working (automation invariant #3).
 */
@Injectable()
export class DepositReconciliationJob implements Job {
  readonly key = 'deposit_reconciliation';
  readonly name = 'Top-up reconciliation';
  readonly description =
    'Asks the gateway about pending and expired top-ups: credits what it confirms, flags an amount it reports differently (F-092-l).';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(DepositReconciliationJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    // Its own budget, and larger than the expiry sweep's: a batch here is one
    // call to a bank per payment, and the bank is the slow part.
    this.timeoutMs = config.get<number>('BILLING_RECONCILE_TIMEOUT_MS', 120_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const counts = await this.reconcile();
    if (counts.confirmed > 0 || counts.flagged > 0) {
      this.logger.log(
        `reconciled ${counts.scanned}: ${counts.confirmed} credited, ${counts.flagged} flagged for a person`,
      );
    }
    // A flagged mismatch is the one outcome that wants a human, and the only
    // way this job has to say so is the run row an operator reads.
    if (counts.flagged > 0) {
      this.logger.warn(`${counts.flagged} payment(s) flagged_mismatch — billing.payment_reconciliation_log has them`);
    }
    return {
      itemsProcessed: counts.scanned,
      errorsCount: counts.errors,
      metrics: { ...counts },
    };
  }

  private async reconcile(): Promise<ReconciliationCounts> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${RECONCILE_PATH}`, {
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
        // the shape a rotated-away `SERVICE_AUTH_TOKEN` takes here.
        throw new Error(`billing answered ${response.status} to ${RECONCILE_PATH}`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      const counts = Object.fromEntries(COUNTS.map((k) => [k, body?.[k]]));
      if (!Object.values(counts).every((v) => typeof v === 'number')) {
        throw new Error(`billing answered ${RECONCILE_PATH} without its five counts`);
      }
      return counts as ReconciliationCounts;
    } finally {
      clearTimeout(timer);
    }
  }
}
