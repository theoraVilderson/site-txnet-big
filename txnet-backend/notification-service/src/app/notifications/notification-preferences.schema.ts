import { BackendI18nKeys, RETENTION_MUTABLE_KINDS } from '@txnet-backend/shared-core';
import { z } from 'zod';

const invalid = BackendI18nKeys.errors.validation.failed;

/** `HH:MM`, 24 h — what the panel's time field sends. */
const clock = z.string({ message: invalid }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: invalid });

/** An IANA zone this runtime can compute in: the one it will be read in. */
const timezone = z
  .string({ message: invalid })
  .min(1, { message: invalid })
  .max(64, { message: invalid })
  .refine(
    (zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    },
    { message: invalid },
  );

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
