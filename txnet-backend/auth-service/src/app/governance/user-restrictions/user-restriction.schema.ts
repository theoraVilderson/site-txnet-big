import { z } from 'zod';

/** The `:key` of `…/restrictions/:key` (F-030-d): shape only — the registry decides whether it exists. */
export const restrictionKeyParamSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/**
 * `PUT …/restrictions/:key` (F-030-d): the value as the key's kind reads it (a
 * count, or the barred options), why, and an optional end. What a value may
 * be is the registry's (`restrictionValueOf`); this bounds the shape only.
 */
export const setRestrictionSchema = z
  .object({
    value: z.union([z.number(), z.array(z.string().max(64)).max(64)]),
    reason: z.string().trim().min(3).max(500),
    expiresAt: z.coerce.date().nullable().optional(),
  })
  .strict();
/** `Required` for the two mandatory fields; this project's non-strict inference reads them optional. */
export type SetRestrictionInput = Required<Pick<z.infer<typeof setRestrictionSchema>, 'value' | 'reason'>> & Pick<z.infer<typeof setRestrictionSchema>, 'expiresAt'>;
