import { MONEY_PATTERN } from '@txnet-backend/shared-core';
import { z } from 'zod';

/** A limit's value (ADR-0106): a whole number ≥ 0, or `null` for no limit. Required, so an empty body changes nothing. The key's own bound is the service's check. */
export const limitValue = z.number().int().min(0).nullable();

export const setLimitSchema = z.object({ value: limitValue }).strict();

const tenantIds = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'tenantIds must not repeat' });

/** One or several resellers at once; the reason is kept on each row and its audit. */
export const setResellersLimitSchema = z.object({ tenantIds, value: limitValue, reason: z.string().trim().min(1).max(500) }).strict();

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
  .regex(MONEY_PATTERN, 'unitPrice must be a decimal string')
  .refine((v) => Number(v) > 0, { message: 'unitPrice must be above zero' });

/** `stop` or `overage` at a price, plus the fields of `shape` — one definition for every body that carries overage terms. */
export function overageTermsWith<T extends z.ZodRawShape>(shape: T) {
  return z.discriminatedUnion('mode', [z.object({ mode: z.literal('stop'), ...shape }).strict(), z.object({ mode: z.literal('overage'), unitPrice, ...shape }).strict()]);
}

const overage = overageTermsWith({});

export const setOverageSchema = overage;

export const setResellersOverageSchema = overageTermsWith({ tenantIds, reason: z.string().trim().min(1).max(500) });

/** Written out rather than inferred: this project's tsconfig infers every field optional, and `mode` is the union's tag. */
export type SetOverageInput = { mode: 'stop' } | { mode: 'overage'; unitPrice: string };
export type SetResellersOverageInput = SetOverageInput & { tenantIds: string[]; reason: string };

/** The reseller's own overage cap per subscription month (F-019-v2): an amount ≥ 0 with at most 2 places, or `null` for none. `0` = no overage at all. */
export const setOverageCapSchema = z
  .object({ amount: z.string().regex(MONEY_PATTERN, 'amount must be a decimal string').nullable() })
  .strict();

export type SetOverageCapInput = { amount: string | null };

/** A window's included sales (F-019-v6): a whole number ≥ 0, or `null` (or absent) for no bound in it. */
const included = z.number().int().min(0).max(10_000_000).nullable().optional();

/**
 * Lists a platform product on a package (F-019-v5) and states its sales quota
 * (F-019-v6): included per fixed day / week / month, and past any of them
 * `stop` (the default) or `overage` at one unit price. The whole terms each
 * time: a field left out is no bound, an `overage` left out is `stop`. `{}`
 * lists it with no quota.
 */
export const setPackageProductSchema = z.object({ day: included, week: included, month: included, overage: overage.optional() }).strict();

export type SetPackageProductInput = { day?: number | null; week?: number | null; month?: number | null; overage?: SetOverageInput };
