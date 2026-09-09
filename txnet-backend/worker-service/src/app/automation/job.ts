import { BotWorkerCategory } from '@prisma/client';

/** What a run reports back, and what lands in `bot_execution_log`. */
export interface JobResult {
  itemsProcessed?: number;
  errorsCount?: number;
  /** Free-form, per the schema's own example: `{"sent": 950, "failed": 12}`. */
  metrics?: Record<string, unknown>;
}

/**
 * One background job.
 *
 * `key` is the `bot_worker.key` — unique and stable, because it is referenced
 * by string (invariant #4). It is also the routing key suffix
 * (`automation.tick.<key>`), which is what keeps the two from drifting: a
 * renamed key stops matching its own tick immediately and loudly, rather than
 * matching a stale row for ever.
 *
 * A handler must be **safe to run twice**. Delivery is at-least-once
 * (ADR-0027), so redelivery after a crash is ordinary, not exceptional. A job
 * that genuinely cannot tolerate it carries its own guard; the queue has none.
 */
export interface Job {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly category: BotWorkerCategory;
  run(): Promise<JobResult>;
}

/**
 * The multi-provider every job registers under, the way `auth-service` injects
 * `OTP_SENDERS` as a set rather than three classes by name (F-055). Adding a
 * job is one class and one provider entry, and nothing else in this service
 * learns its name.
 */
export const JOBS = Symbol('JOBS');
