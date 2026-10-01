import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const DIGEST_PATH = '/api/internal/notifications/reseller-quota/digest';

/**
 * Tells each reseller's owner yesterday's quota digest — units refused,
 * overage units and their cost (F-019-v8, ADR-0107 point 11). notification-service
 * decides: nothing before 09:00 on the quota clock, each reseller once a day
 * after it, nobody on a day with neither. The notice itself is the outbox
 * event it writes (`tenant.quota.digest`), told by `TenantSubscriptionNoticeConsumer`.
 *
 * **Hourly**, so a quota clock in any zone reaches its 09:00 within the hour,
 * and a run missed is made up by the next. A platform tick (no `tenantId`).
 * It never succeeds quietly: an unset seam, a refusal or an answer without its
 * counts throws.
 */
@Injectable()
export class ResellerQuotaDigestJob implements Job {
  readonly key = 'reseller_quota_digest';
  readonly name = 'Reseller quota digest';
  readonly description = "Tells each reseller yesterday's refused units and overage cost, from 09:00 on the quota clock (F-019-v8).";
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, no reseller hears its daily digest; the 80% / 100% alerts do not depend on it. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '5 * * * *' };

  private readonly logger = new Logger(ResellerQuotaDigestJob.name);
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
      const response = await fetch(`${this.baseUrl}${DIGEST_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`notification-api answered ${response.status} to ${DIGEST_PATH}`);
      const data = envelopeData(await response.json());
      if (typeof data?.resellers !== 'number' || typeof data?.told !== 'number') {
        throw new Error(`notification-api answered ${DIGEST_PATH} without its counts`);
      }
      if (data.told > 0) this.logger.log(`quota digest told ${data.told} reseller(s)`);
      return { itemsProcessed: data.told, errorsCount: 0, metrics: { resellers: data.resellers, told: data.told } };
    } finally {
      clearTimeout(timer);
    }
  }
}
