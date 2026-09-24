import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const FULFIL_DUE_PATH = '/api/internal/billing/network/fulfil-due';
const COUNTS = ['scanned', 'configsPlaced', 'grantsActivated', 'grantsFailed'] as const;

/**
 * The clock on panel-group fulfilment (F-027-bl, network `contract.groups.md`).
 *
 * A Grant of a variant with a panel group gets a config on every non-drain
 * healthy member, and activates once `minHealthyPanels` are confirmed. A member
 * that is down is filled when it is healthy again, and a confirmation arrives
 * whenever the convergence pass reads it — so this is a retry loop, and the
 * work, like `grant-purge.job.ts`'s, is billing-service's behind the internal
 * seam. This job holds only *when*.
 *
 * **Every minute.** A buyer waits on the activation; the scan names only Grants
 * with a write due, so an idle tick is one query.
 *
 * **Safe to run twice** (ADR-0027): a covered panel is never placed on again,
 * and `config_group_panel_once` refuses the loser of two concurrent runs.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class GrantGroupFulfilmentJob implements Job {
  readonly key = 'grant_group_fulfilment';
  readonly name = 'Panel group fulfilment';
  readonly description =
    'Places a config on every non-drain healthy member of a Grant\'s panel group and activates it at minHealthyPanels (F-027-bl).';
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(GrantGroupFulfilmentJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('BILLING_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('BILLING_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not at boot (`vault-retention.job.ts`): an unconfigured
    // seam fails this job's run and leaves the rest of the queue draining.
    if (!this.baseUrl) throw new Error('BILLING_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.fulfilDue();
    if (result.configsPlaced > 0 || result.grantsActivated > 0) {
      this.logger.log(`placed ${result.configsPlaced} config(s), activated ${result.grantsActivated} Grant(s)`);
    }
    return { itemsProcessed: result.configsPlaced + result.grantsActivated, errorsCount: result.grantsFailed, metrics: { ...result } };
  }

  private async fulfilDue(): Promise<Record<(typeof COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${FULFIL_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      // 404 is the guard's answer to a caller it does not recognise.
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${FULFIL_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${FULFIL_DUE_PATH} without its four counts`);
      return Object.fromEntries(COUNTS.map((k, i) => [k, counts[i] as number])) as Record<(typeof COUNTS)[number], number>;
    } finally {
      clearTimeout(timer);
    }
  }
}
