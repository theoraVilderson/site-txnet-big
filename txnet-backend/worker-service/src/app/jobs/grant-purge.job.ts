import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const PURGE_DUE_PATH = '/api/internal/billing/entitlement/purge-due';

/**
 * The clock on a suspended Grant's panel seats (F-027-y, ADR-0075).
 *
 * A Grant whose bag ran empty is turned off at once (F-027-x), but a disabled
 * client still occupies a seat and a licence on the customer's panel, and
 * panels are licensed by user count. This is the second stage: after
 * `purgeAfterDays` the client is dropped, the seat comes back, and **our row
 * stays** with its desired state intact — which is what makes a rebuild a
 * button rather than a reconstruction.
 *
 * **The work is entitlement's and the clock is this service's.** Resolving the
 * window means a Grant override against a tenant default, a cross-tenant scan
 * and a per-tenant write — all inside `billing-service`, which an Nx
 * application cannot import. So this asks over the internal seam, exactly as
 * `deposit-expiry.job.ts` does, and holds only `SERVICE_AUTH_TOKEN`.
 *
 * **Hourly, not by the minute.** The window is measured in days, so a purge an
 * hour late costs nothing; a sweep on the tick interval would be a cross-tenant
 * join every minute for a row that changes daily.
 *
 * **Safe to run twice** (the `Job` contract, ADR-0027): the scan on the other
 * side skips Grants whose configs are already `absent`, so a redelivered tick
 * purges nothing and answers zero.
 *
 * **It never succeeds quietly.** An unset seam, a guard's 404 and an answer in
 * a shape this does not recognise are each indistinguishable from "nothing was
 * due" if the run reports zero and success — and a retention sweep is exactly
 * the kind of job nobody looks at while it is working. Each one throws, and
 * `TickConsumer` records a `failed` run (automation invariant #3).
 *
 * **The same call closes Grants past their close window (F-118-x)**, and a
 * close moves money. A close that rolled back is asked again next hour, so it
 * is an error of this run (`partial`, or `failed` with nothing else done) —
 * never a quiet `success` that repeats every hour unseen.
 */
@Injectable()
export class GrantPurgeJob implements Job {
  readonly key = 'grant_config_purge';
  readonly name = 'Suspended Grant purge';
  readonly description =
    'Releases the panel seats of suspended Grants past their purgeAfterDays, without deleting our rows (ADR-0075), tells those a day away (F-601-j), and closes those past their close window (F-118-x).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a spent Grant's clients hold their panel seats for ever. Hourly: the window is days; twenty past, off the hour. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '20 * * * *' };

  private readonly logger = new Logger(GrantPurgeJob.name);
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

    const result = await this.purgeDue();
    if (result.configsPurged > 0) {
      this.logger.log(
        `purged ${result.configsPurged} config(s) of ${result.grantsPurged} suspended Grant(s)`,
      );
    }
    if (result.closeFailed > 0) this.logger.warn(`${result.closeFailed} Grant close(s) rolled back; asked again next hour`);
    return {
      itemsProcessed: result.configsPurged + result.closed,
      errorsCount: result.closeFailed,
      metrics: { ...result },
    };
  }

  private async purgeDue(): Promise<{ scanned: number; grantsPurged: number; configsPurged: number; told: number; closed: number; closeFailed: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${PURGE_DUE_PATH}`, {
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
        // the shape a rotated-away `SERVICE_AUTH_TOKEN` takes here — deliberately
        // indistinguishable from a route that does not exist.
        throw new Error(`billing answered ${response.status} to ${PURGE_DUE_PATH}`);
      }

      // billing answers `{ ok, msg, data }` (`envelopeData`).
      const body = envelopeData(await response.json());
      // `told`: the suspended Grants told their purge is within a day (F-601-j), swept in the same call;
      // `closed`/`closeFailed`: the close stage, run last in it (F-118-x).
      const counts = ['scanned', 'grantsPurged', 'configsPurged', 'told', 'closed', 'closeFailed'].map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) {
        throw new Error(`billing answered ${PURGE_DUE_PATH} without its counts`);
      }
      const [scanned, grantsPurged, configsPurged, told, closed, closeFailed] = counts as number[];
      return { scanned, grantsPurged, configsPurged, told, closed, closeFailed };
    } finally {
      clearTimeout(timer);
    }
  }
}
