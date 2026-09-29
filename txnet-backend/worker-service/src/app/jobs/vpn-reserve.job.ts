import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const RESERVE_DUE_PATH = '/api/internal/billing/traffic/reserve-due';
const RESERVE_COUNTS = ['scanned', 'topped', 'released', 'errors'] as const;

/**
 * The clock on the VPN reserve (F-118-b, ADR-0105 (8)): every metered Grant's
 * reserve topped to its target from the free balance, and every reserve of a
 * Grant no longer planned released. Billing decides and moves the money
 * (`traffic/vpn-reserve.ts`); the clock is this service's, as `usage_capture`'s is.
 *
 * **Every minute, as a backstop**: issue, every block and every way back to
 * active top a reserve at once, and every stop releases one at once; this
 * catches a deposit into a reserve held short and any path that missed a write.
 *
 * **Safe to run twice** (ADR-0027): a reserve at its target writes nothing.
 *
 * **It never succeeds quietly**: an unset seam, a 404 and an unreadable answer
 * each throw, so `TickConsumer` records a `failed` run (automation invariant #3).
 */
@Injectable()
export class VpnReserveJob implements Job {
  readonly key = 'vpn_reserve';
  readonly name = 'VPN reserve';
  readonly description =
    'Holds each metered VPN service its reserve past the bag, and releases the reserve of one no longer served (F-118-b).';
  readonly category = BotWorkerCategory.other;
  /** Unscheduled, a reserve held short stays short until its next block, and a missed release stays locked. Every minute. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'cron_expression', cronExpression: '* * * * *' };

  private readonly logger = new Logger(VpnReserveJob.name);
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

    const result = await this.reserveDue();
    if (result.topped + result.released > 0) {
      this.logger.log(`topped ${result.topped} and released ${result.released} of ${result.scanned} VPN reserve(s)`);
    }
    return { itemsProcessed: result.topped + result.released, errorsCount: result.errors, metrics: { ...result } };
  }

  private async reserveDue(): Promise<Record<(typeof RESERVE_COUNTS)[number], number>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${RESERVE_DUE_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`billing answered ${response.status} to ${RESERVE_DUE_PATH}`);

      const body = envelopeData(await response.json());
      const counts = RESERVE_COUNTS.map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) throw new Error(`billing answered ${RESERVE_DUE_PATH} without its ${RESERVE_COUNTS.length} counts`);
      const [scanned, topped, released, errors] = counts as number[];
      return { scanned, topped, released, errors };
    } finally {
      clearTimeout(timer);
    }
  }
}
