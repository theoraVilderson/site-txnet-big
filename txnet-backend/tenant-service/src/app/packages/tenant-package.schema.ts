import { TENANT_FEATURE_KEYS } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of a package the platform sells resellers (F-018-d).
 *
 * A price is a base-currency decimal string with at most two places, never a
 * number (C-02), and positive: a free package is not a price. `.strict()`: the
 * two old metering columns are not the caller's to fill (D-41).
 *
 * `meterRates` is the wholesale price list (F-118-n1, ADR-0105 (10)): per
 * platform meter, what the platform charges a reseller on this package for
 * `unitSize` of it — 2^30 for a GiB of `vpn.traffic`. Strings, as a rate card
 * takes them (F-118-m): a whole `unitSize` of at least 1, a positive
 * `unitPrice` to 8 places. On an edit `unitPrice: null` switches a meter off.
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

const UNIT_PRICE = /^(0|[1-9]\d{0,9})(\.\d{1,8})?$/;
const UNIT_SIZE = /^[1-9]\d{0,18}$/;

const meterKey = z.string().min(1).max(100);
const meterRate = z
  .object({
    meterKey,
    unitSize: z.string({ message: 'unitSize must be a whole number string' }).regex(UNIT_SIZE, { message: 'unitSize is a whole number of at least 1' }),
    unitPrice: z
      .string({ message: 'unitPrice must be a decimal string' })
      .regex(UNIT_PRICE, { message: 'unitPrice must be a decimal string' })
      .refine((s) => /[1-9]/.test(s), { message: 'unitPrice must be positive' }),
  })
  .strict();
/** Only on an edit: the meter's rates are switched off. */
const meterRateOff = z.object({ meterKey, unitPrice: z.null() }).strict();

const eachMeterOnce = (rates: { meterKey: string }[]) => new Set(rates.map((r) => r.meterKey)).size === rates.length;
const meterRates = z.array(meterRate).max(50).refine(eachMeterOnce, { message: 'a meter is repeated' });
const meterRateEdits = z.array(z.union([meterRate, meterRateOff])).max(50).refine(eachMeterOnce, { message: 'a meter is repeated' });

export type MeterRateInput = z.infer<typeof meterRate>;
export type MeterRateEdit = z.infer<typeof meterRate> | z.infer<typeof meterRateOff>;

export const createPackageSchema = z
  .object({
    name,
    monthlyPrice: price.optional(),
    yearlyPrice: price.optional(),
    includedFeatureKeys: featureKeys,
    meterRates: meterRates.optional(),
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
    meterRates: meterRateEdits.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nothing to change' });

export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;

export const listPackagesSchema = z
  .object({ active: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional() })
  .strict();

export type ListPackagesInput = z.infer<typeof listPackagesSchema>;
