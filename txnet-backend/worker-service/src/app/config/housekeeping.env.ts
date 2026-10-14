import { z } from 'zod';

/**
 * The keep windows of `automation_housekeeping` (hosting H14), spread into
 * `envSchema`. Their own file because `env.validation.ts` is at its size
 * baseline (C-20).
 */
export const housekeepingEnv = {
  /** Days a successful run's `bot_execution_log` row is kept. */
  AUTOMATION_LOG_KEEP_DAYS: z.coerce.number().int().positive().default(30),
  /** Days a failed or partial run is kept: the failures are what an operator comes back to read. */
  AUTOMATION_LOG_KEEP_FAILED_DAYS: z.coerce.number().int().positive().default(90),
  /** Days a published `outbox_event` is kept. An unpublished one is never deleted. */
  OUTBOX_KEEP_DAYS: z.coerce.number().int().positive().default(7),
};
