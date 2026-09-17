import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const RENEW_DUE_PATH = '/api/internal/tenant-subscriptions/renew-due';
const OUTCOMES = ['renewed', 'warned', 'suspended', 'waiting', 'not_due', 'skipped'] as const;

/**
 * Renews every due reseller subscription from its billing wallet (F-019-c,
 * `domains/tenant/rules.md` #10-#13): charges the paid, warns the short, and
 * suspends the ones whose grace ran out. The credited-wallet event renews a
 * payer at once; this sweep is what keeps the rules true when that event is
 * lost, and what finds a period that simply ended.
 *
 * A platform tick (no `tenantId`), so `TenantStatusGate` does not judge it — a
 * suspended reseller is exactly one this must reach. Safe to run twice: a
 * renewed period is no longer due, and a warning waits a day. Like every job
 * here it never succeeds quietly: an unset seam, a refusal or an answer without
 * the counts throws, and `failed` renewals are its `errorsCount`.
 */
@Injectable()
export class TenantSubscriptionRenewalJob implements Job {
  readonly key = 'tenant_subscription_renewal';
  readonly name = 'Reseller subscription renewal';
  readonly description = "Charges due reseller subscriptions from their billing wallet; warns, then suspends, an unpaid one (F-019-c).";
  readonly category = BotWorkerCategory.other;

  private readonly logger = new Logger(TenantSubscriptionRenewalJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('TENANT_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    if (!this.baseUrl) throw new Error('TENANT_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${RENEW_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`tenant-api answered ${response.status} to ${RENEW_DUE_PATH}`);
      const data = envelopeData(await response.json());
      const counts = [...OUTCOMES, 'due', 'failed'].map((k) => [k, data?.[k]] as const);
      if (counts.some(([, v]) => typeof v !== 'number')) {
        throw new Error(`tenant-api answered ${RENEW_DUE_PATH} without its outcome counts`);
      }
      const metrics = Object.fromEntries(counts) as Record<string, number>;
      if (metrics.renewed || metrics.suspended) {
        this.logger.log(`renewed ${metrics.renewed}, suspended ${metrics.suspended}, warned ${metrics.warned}`);
      }
      return { itemsProcessed: metrics.due, errorsCount: metrics.failed, metrics };
    } finally {
      clearTimeout(timer);
    }
  }
}
