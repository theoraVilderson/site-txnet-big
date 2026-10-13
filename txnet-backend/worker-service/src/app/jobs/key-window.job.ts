import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotWorkerCategory } from '@prisma/client';
import { DefaultSchedule, Job, JobResult } from '../automation/job';
import { authInternalCall, postForCounts, type InternalCall } from '../automation/internal-answer';

/** The one route this job exists to call. Service callers only; 404 otherwise. */
const KEY_WINDOWS_PATH = '/api/internal/user-keys/windows';

/**
 * The clock on a key given for a window (F-030-a, ADR-0138 (7)).
 *
 * The rule is auth-service's (`key-window.sweep.ts`): mark each window whose
 * start passed and remove each whose end passed — either moves the person's
 * token — and tell them what they gained or lost. This only calls it, as
 * `group-membership-end.job.ts` calls GR-1-c's. Safe to run twice.
 */
@Injectable()
export class KeyWindowJob implements Job {
  readonly key = 'key_window';
  readonly name = 'Key windows';
  readonly description = 'Opens and closes keys given to one person for a window, moves their access and tells them (F-030-a).';
  readonly category = BotWorkerCategory.other;
  /** A platform sweep: it acts on every tenant, each in its own scope. */
  readonly tenantCapability = 'system' as const;
  /** Unscheduled, a window's holder is never told and an open session keeps its keys until it refreshes. */
  readonly defaultSchedule: DefaultSchedule = { scheduleType: 'always_on' };

  private readonly logger = new Logger(KeyWindowJob.name);
  private readonly call: () => InternalCall;

  constructor(config: ConfigService) {
    this.call = authInternalCall(config, KEY_WINDOWS_PATH);
  }

  async run(): Promise<JobResult> {
    const result = await postForCounts(this.call(), ['opened', 'closed', 'told'] as const);
    if (result.opened + result.closed > 0) this.logger.log(`opened ${result.opened}, closed ${result.closed} key window(s), told ${result.told}`);
    return { itemsProcessed: result.opened + result.closed, errorsCount: 0, metrics: { ...result } };
  }
}
