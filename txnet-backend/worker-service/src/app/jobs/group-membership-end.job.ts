import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { authInternalCall, postForCounts, type InternalCall } from '../automation/internal-answer';

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
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = authInternalCall(config, END_MEMBERSHIPS_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts(this.call(), ['ended', 'told'] as const);
    if (result.ended > 0) this.logger.log(`ended ${result.ended} group membership(s), told ${result.told}`);
    return { itemsProcessed: result.ended, errorsCount: 0, metrics: { ...result } };
  }
}
