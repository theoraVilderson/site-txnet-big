import { ScheduleType } from '@prisma/client';
import { PLATFORM_DEFAULT_TIMEZONE } from '@txnet-backend/shared-core';
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
  scheduleType: z.nativeEnum(ScheduleType),
  windowStartAt: z.coerce.date().nullish(),
  windowEndAt: z.coerce.date().nullish(),
  cronExpression: z.string().trim().min(1).nullish(),
  // The column's own default, repeated here rather than left to Prisma: a
  // schedule whose timezone the caller did not state is read on the platform
  // clock, and that is a fact worth being visible at the surface that accepts
  // it. TZ-1-g moves this default to the tenant's zone.
  timezone: z.string().min(1).default(PLATFORM_DEFAULT_TIMEZONE),
});

export const toggleWorkerSchema = z.object({ isActive: z.boolean() });

export type SetScheduleInput = z.infer<typeof setScheduleSchema>;
export type ToggleWorkerInput = z.infer<typeof toggleWorkerSchema>;
