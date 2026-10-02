import { ScheduleType } from '@prisma/client';
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
  // Absent = the caller's tenant zone, resolved by the service (TZ-1-g,
  // ADR-0108 point 6). No default here: a literal would be the drift the ADR ends.
  timezone: z.string().min(1).nullish(),
});

export const toggleWorkerSchema = z.object({ isActive: z.boolean() });

export type SetScheduleInput = z.infer<typeof setScheduleSchema>;
export type ToggleWorkerInput = z.infer<typeof toggleWorkerSchema>;
