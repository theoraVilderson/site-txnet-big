import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The routes these jobs exist to call. Service callers only; 404 otherwise. */
const RECONCILE_PATH = '/api/internal/billing/deposit/reconcile';
const VERIFY_DUE_PATH = '/api/internal/billing/deposit/verify-due';

/** The counts billing answers with. All five, or the answer is not one this job understands. */
const COUNTS = ['scanned', 'confirmed', 'flagged', 'unchanged', 'errors'] as const;

type ReconciliationCounts = Record<(typeof COUNTS)[number], number> & {
  /** Still verifying a day after it was made, flagged this run (F-092-y). Absent from an older billing. */
  flaggedForPerson?: number;
};

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
  readonly key: string = 'deposit_reconciliation';
  readonly name: string = 'Top-up reconciliation';
  readonly description: string =
    'Asks the gateway about pending and expired top-ups nobody came back for: credits what it confirms and flags an amount it reports differently (F-092-l). Verifying ones are deposit_verify_retry\'s.';
  readonly category = BotWorkerCategory.other;
  /** The billing route a run calls. */
  protected readonly path: string = RECONCILE_PATH;

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
    if (counts.flaggedForPerson) {
      this.logger.warn(
        `${counts.flaggedForPerson} payment(s) still verifying after a day — payment_transaction.verifyFlaggedAt has them`,
      );
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
      const response = await fetch(`${this.baseUrl}${this.path}`, {
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
        throw new Error(`billing answered ${response.status} to ${this.path}`);
      }

      // billing answers `{ ok, msg, data }` (`envelopeData`).
      const body = envelopeData(await response.json());
      const counts = Object.fromEntries(COUNTS.map((k) => [k, body?.[k]]));
      if (!Object.values(counts).every((v) => typeof v === 'number')) {
        throw new Error(`billing answered ${this.path} without its five counts`);
      }
      const flaggedForPerson = body?.['flaggedForPerson'];
      return {
        ...(counts as ReconciliationCounts),
        ...(typeof flaggedForPerson === 'number' ? { flaggedForPerson } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Asking again about verifying payments whose retry is due (F-092-ac,
 * ADR-0046 decision 3).
 *
 * The same seam, answer and failure rules as reconciliation, on a different
 * route and a different schedule: `always_on`, one tick a minute. Riding the
 * five-minute sweep kept the retry ladder's 30 s rung waiting up to five
 * minutes, and a payer watches `/payment/pending` for exactly that long.
 */
@Injectable()
export class DepositVerifyRetryJob extends DepositReconciliationJob {
  override readonly key = 'deposit_verify_retry';
  override readonly name = 'Top-up verify retry';
  override readonly description =
    'Asks the gateway again about verifying top-ups whose retry is due: credits what it confirms, re-schedules silence, flags a payment still verifying after a day (F-092-x, F-092-y, F-092-ac).';
  protected override readonly path = VERIFY_DUE_PATH;
}

