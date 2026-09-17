import { TENANT_FEATURE_KEYS } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of a package the platform sells resellers (F-018-d).
 *
 * A price is a base-currency decimal string with at most two places, never a
 * number (C-02), and positive: a free package is not a price. `.strict()`: the
 * two metering columns are not the caller's to fill (D-41).
 */

const DECIMAL = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;

const price = z
  .string({ message: 'price must be a decimal string' })
  .regex(DECIMAL, { message: 'price must be a decimal string' })
  .refine((s) => /[1-9]/.test(s), { message: 'price must be positive' });

const featureKeys = z
  .array(z.enum(TENANT_FEATURE_KEYS))
  .max(TENANT_FEATURE_KEYS.length)
  .refine((keys) => new Set(keys).size === keys.length, { message: 'a feature key is repeated' });

const name = z.string().trim().min(1).max(80);

export const createPackageSchema = z
  .object({
    name,
    monthlyPrice: price.optional(),
    yearlyPrice: price.optional(),
    includedFeatureKeys: featureKeys,
  })
  .strict()
  .refine((p) => p.monthlyPrice !== undefined || p.yearlyPrice !== undefined, {
    message: 'a package needs a monthly or a yearly price',
  });

export type CreatePackageInput = z.infer<typeof createPackageSchema>;

/** `null` clears a price; the service refuses an edit that leaves none. `isActive: false` deactivates. */
export const updatePackageSchema = z
  .object({
    name: name.optional(),
    monthlyPrice: price.nullable().optional(),
    yearlyPrice: price.nullable().optional(),
    includedFeatureKeys: featureKeys.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nothing to change' });

export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;

export const listPackagesSchema = z
  .object({ active: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional() })
  .strict();

export type ListPackagesInput = z.infer<typeof listPackagesSchema>;
