import { z } from 'zod';

/** A limit's value (ADR-0106): a whole number ≥ 0, or `null` for no limit. Required, so an empty body changes nothing. The key's own bound is the service's check. */
const value = z.number().int().min(0).nullable();

export const setLimitSchema = z.object({ value }).strict();

const tenantIds = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'tenantIds must not repeat' });

/** One or several resellers at once; the reason is kept on each row and its audit. */
export const setResellersLimitSchema = z.object({ tenantIds, value, reason: z.string().trim().min(1).max(500) }).strict();

export const clearResellersLimitSchema = z.object({ tenantIds }).strict();

export type SetLimitInput = z.infer<typeof setLimitSchema>;
export type SetResellersLimitInput = z.infer<typeof setResellersLimitSchema>;
export type ClearResellersLimitInput = z.infer<typeof clearResellersLimitSchema>;
