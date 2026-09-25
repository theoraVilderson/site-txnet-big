import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const CHECK_DUE_PATH = '/api/internal/tenant-domains/check-due';
const OUTCOMES = ['verified', 'waiting', 'failed', 'revalidated', 'revalidating', 'dropped'] as const;

/**
 * Checks resellers' custom domains (F-018-i, `domains/tenant/contract.domains.md`):
 * a `verifying` one every tick until it is `verified` or its window closes, a
 * `verified` one's TXT record when its re-validation is due, and one whose
 * record went missing every tick until it returns or the grace ends.
 *
 * A platform tick (no `tenantId`). Safe to run twice: `tenant-service` writes
 * a row only in the status it was read in. It never succeeds quietly: an unset
 * seam, a refusal or an answer without the counts throws, and a domain whose
 * check threw is an `errorsCount`.
 */
@Injectable()
export class TenantDomainVerificationJob implements Job {
  readonly key = 'tenant_domain_verification';
  readonly name = 'Reseller custom-domain verification';
  readonly description = "Checks resellers' custom domains: TXT record, CNAME and an http/https answer; re-validates verified ones (F-018-i).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, no custom domain ever becomes `verified`. An idle run is one query. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '*/5 * * * *' };

  private readonly logger = new Logger(TenantDomainVerificationJob.name);
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
    // A tick probes up to 50 domains, each bounded by DOMAIN_PROBE_TIMEOUT_MS on tenant-service's side.
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 120_000));
    try {
      const response = await fetch(`${this.baseUrl}${CHECK_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`tenant-api answered ${response.status} to ${CHECK_DUE_PATH}`);
      const data = envelopeData(await response.json());
      const counts = [...OUTCOMES, 'due', 'errors'].map((k) => [k, data?.[k]] as const);
      if (counts.some(([, v]) => typeof v !== 'number')) {
        throw new Error(`tenant-api answered ${CHECK_DUE_PATH} without its outcome counts`);
      }
      const metrics = Object.fromEntries(counts) as Record<string, number>;
      if (metrics.verified || metrics.dropped) {
        this.logger.log(`verified ${metrics.verified}, dropped ${metrics.dropped}`);
      }
      return { itemsProcessed: metrics.due, errorsCount: metrics.errors, metrics };
    } finally {
      clearTimeout(timer);
    }
  }
}
