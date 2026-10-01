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

/**
 * Past a quota key (ADR-0107 point 2): `stop`, or `overage` at a unit price —
 * a positive amount with at most 2 decimals, as a string so it is never a
 * float (C-02). Its currency is the platform's, stamped by the service.
 */
const unitPrice = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'unitPrice must be a decimal with at most 2 places')
  .refine((v) => Number(v) > 0, { message: 'unitPrice must be above zero' });

const overage = z.discriminatedUnion('mode', [z.object({ mode: z.literal('stop') }).strict(), z.object({ mode: z.literal('overage'), unitPrice }).strict()]);

export const setOverageSchema = overage;

export const setResellersOverageSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('stop'), tenantIds, reason: z.string().trim().min(1).max(500) }).strict(),
  z.object({ mode: z.literal('overage'), unitPrice, tenantIds, reason: z.string().trim().min(1).max(500) }).strict(),
]);

/** Written out rather than inferred: this project's tsconfig infers every field optional, and `mode` is the union's tag. */
export type SetOverageInput = { mode: 'stop' } | { mode: 'overage'; unitPrice: string };
export type SetResellersOverageInput = SetOverageInput & { tenantIds: string[]; reason: string };

/** The reseller's own overage cap per subscription month (F-019-v2): an amount ≥ 0 with at most 2 places, or `null` for none. `0` = no overage at all. */
export const setOverageCapSchema = z
  .object({ amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'amount must be a decimal with at most 2 places').nullable() })
  .strict();

export type SetOverageCapInput = { amount: string | null };
