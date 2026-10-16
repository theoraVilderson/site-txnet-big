import { z } from 'zod';

/** A calendar date as `YYYY-MM-DD` that names a real day (`2026-02-30` is refused, `not_a_day`). */
export const calendarDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d, 'not_a_day');
