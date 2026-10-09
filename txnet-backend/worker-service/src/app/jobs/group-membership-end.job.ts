import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { envelopeData } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const END_MEMBERSHIPS_PATH = '/api/internal/user-groups/end-memberships';

/**
 * The clock on a group membership's end (GR-1-c, ADR-0139 (3)).
 *
 * The rule is auth-service's (`membership-end.sweep.ts`): remove each
 * membership past its end, which moves the person's token, and tell them what
 * they lost. This only calls it, as `invoice-expiry.job.ts` calls billing's.
 * Safe to run twice: a removed membership is not found again. An answer it
 * cannot read fails the run rather than reporting zero (automation
 * invariant #3).
 */
@Injectable()
export class GroupMembershipEndJob implements Job {
  readonly key = 'group_membership_end';
  readonly name = 'Group membership end';
  readonly description = 'Removes group memberships past their end, moves those people\'s access and tells them (GR-1-c).';
  readonly category = BotWorkerCategory.other;
  /** A platform sweep: it acts on every tenant, each in its own scope. */
  readonly tenantCapability = 'system' as const;
  /** Unscheduled, an ended membership's holder is never told and their open session keeps its keys until it refreshes. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };

  private readonly logger = new Logger(GroupMembershipEndJob.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('AUTH_API_BASE_URL', '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 30_000);
  }

  async run(): Promise<JobResult> {
    // Read at run time, not boot, for the reason `deposit-expiry.job.ts` gives.
    if (!this.baseUrl) throw new Error('AUTH_API_BASE_URL is not set');
    if (!this.serviceToken) throw new Error('SERVICE_AUTH_TOKEN is not set');

    const result = await this.endMemberships();
    if (result.ended > 0) this.logger.log(`ended ${result.ended} group membership(s), told ${result.told}`);
    return { itemsProcessed: result.ended, errorsCount: 0, metrics: { ...result } };
  }

  private async endMemberships(): Promise<{ ended: number; told: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${END_MEMBERSHIPS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: this.serviceToken },
        body: '{}',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`auth-api answered ${response.status} to ${END_MEMBERSHIPS_PATH}`);

      const body = envelopeData(await response.json());
      const counts = ['ended', 'told'].map((k) => body?.[k]);
      if (!counts.every((v) => typeof v === 'number')) {
        throw new Error(`auth-api answered ${END_MEMBERSHIPS_PATH} without its two counts`);
      }
      const [ended, told] = counts as number[];
      return { ended, told };
    } finally {
      clearTimeout(timer);
    }
  }
}
