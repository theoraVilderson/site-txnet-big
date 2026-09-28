import { z } from 'zod';

/**
 * The wire shape of a set (F-116-a): an ISO 4217-shaped code. Whether the
 * platform has that currency, and a rate for it, is the service's to judge.
 * The same shape the column's CHECK holds.
 */
export const setOperatingCurrencySchema = z
  .object({
    code: z.string().regex(/^[A-Z]{3}$/, 'must be a three-letter currency code like USD'),
  })
  .strict();

export type SetOperatingCurrencyInput = z.infer<typeof setOperatingCurrencySchema>;
