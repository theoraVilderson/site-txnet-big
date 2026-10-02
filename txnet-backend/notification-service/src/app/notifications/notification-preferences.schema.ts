import { BackendI18nKeys, RETENTION_MUTABLE_KINDS, isIanaZone } from '@txnet-backend/shared-core';
import { z } from 'zod';

const invalid = BackendI18nKeys.errors.validation.failed;

/** `HH:MM`, 24 h — what the panel's time field sends. */
const clock = z.string({ message: invalid }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: invalid });

/** An IANA zone, or null for the user's resolved zone (TZ-1-f). A fixed offset is refused (ADR-0108 point 1). */
const timezone = z.string({ message: invalid }).refine(isIanaZone, { message: invalid }).nullable();

/**
 * A user's whole retention notice preferences (F-601-m, spec 9.4), replaced
 * as one. Strict, so a key the panel thinks is saved and this side ignores is
 * a 400. `quietHours` null = none; a window whose ends are equal is refused —
 * it names no hours at all, or all of them, and neither is what was meant.
 * `cutoff` is not a mutable kind: a stopped service is always told.
 */
export const preferencesSchema = z
  .object({
    muted: z.array(z.enum(RETENTION_MUTABLE_KINDS, { message: invalid }), { message: invalid }).max(RETENTION_MUTABLE_KINDS.length, { message: invalid }),
    quietHours: z
      .object({ start: clock, end: clock })
      .strict()
      .refine((w) => w.start !== w.end, { message: invalid })
      .nullable(),
    timezone,
  })
  .strict();
