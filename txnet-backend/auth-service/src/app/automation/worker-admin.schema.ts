import { z } from 'zod';

/**
 * The wire shape of a schedule. Types and presence only — **not** the mutual
 * exclusion between the window columns and `cronExpression`.
 *
 * That rule is invariant #2 and it is answered by `scheduleShapeError`
 * (`@txnet-backend/shared-core`), the same function the tick publisher
 * declines on. Restating it here as a zod refinement would put the invariant
 * in two places and let them drift, which is the failure the invariant is
 * about. Zod's job is to establish that there is a candidate row to check.
 */
export const setScheduleSchema = z.object({
  scheduleType: z.enum(['always_on', 'time_window', 'cron_expression']),
  windowStartAt: z.coerce.date().nullish(),
  windowEndAt: z.coerce.date().nullish(),
  cronExpression: z.string().trim().min(1).nullish(),
  // The column's own default, repeated here rather than left to Prisma: a
  // schedule whose timezone the caller did not state is read in Tehran time,
  // and that is a fact worth being visible at the surface that accepts it.
  timezone: z.string().min(1).default('Asia/Tehran'),
});

export const toggleWorkerSchema = z.object({ isActive: z.boolean() });

export type SetScheduleInput = z.infer<typeof setScheduleSchema>;
export type ToggleWorkerInput = z.infer<typeof toggleWorkerSchema>;
