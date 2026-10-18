import { TENANT_FEATURE_KEYS, MONEY_PATTERN, RESELLER_LIMIT_KEYS, RESELLER_QUOTA_KEYS } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { limitValue, overageTermsWith, setPackageProductSchema, type SetOverageInput, type SetPackageProductInput } from '../limits/reseller-limits.schema';

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
 *
 * `name` is the text in `sourceLang` (absent: `DEFAULT_LANGUAGE`), and so is
 * `description`; both become locale-service text (ADR-0154 decision 5).
 *
 * On create only, the rest of the package may ride along (ADR-0154 decision
 * 4): `limits`, `quotaOverages` and `products`, each entry the body its own
 * endpoint takes (contract.limits.md) plus the key or product it is for.
 */


const price = z
  .string({ message: 'price must be a decimal string' })
  .regex(MONEY_PATTERN, { message: 'price must be a decimal string' })
  .refine((s) => /[1-9]/.test(s), { message: 'price must be positive' });

const featureKeys = z
  .array(z.enum(TENANT_FEATURE_KEYS))
  .max(TENANT_FEATURE_KEYS.length)
  .refine((keys) => new Set(keys).size === keys.length, { message: 'a feature key is repeated' });

const name = z.string().trim().min(1).max(80);
/** A language code as locale-service names it; which exist is its answer, checked by the service (`lang_unknown`). */
const lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, { message: 'lang must be a language code' });
const description = z.string().trim().min(1).max(2000);

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

const eachOnce =
  <T>(idOf: (entry: T) => string) =>
  (entries: T[]) =>
    new Set(entries.map(idOf)).size === entries.length;
const eachMeterOnce = eachOnce((r: { meterKey: string }) => r.meterKey);
const meterRates = z.array(meterRate).max(50).refine(eachMeterOnce, { message: 'a meter is repeated' });
const meterRateEdits = z.array(z.union([meterRate, meterRateOff])).max(50).refine(eachMeterOnce, { message: 'a meter is repeated' });

/** More platform products than one package could list; a bound on the body, not a business rule. */
const MAX_PACKAGE_PRODUCTS = 500;

// A key is any string here: an unknown one is the service's `unknown_limit`, as on the limits endpoints.
const limitKey = z.string().min(1).max(100);
const eachKeyOnce = eachOnce((entry: { key: string }) => entry.key);
const packageLimits = z
  .array(z.object({ key: limitKey, value: limitValue }).strict())
  .max(RESELLER_LIMIT_KEYS.length)
  .refine(eachKeyOnce, { message: 'a limit is repeated' });
const packageOverages = z
  .array(overageTermsWith({ key: limitKey }))
  .max(RESELLER_QUOTA_KEYS.length)
  .refine(eachKeyOnce, { message: 'a limit is repeated' });
const packageProducts = z
  .array(setPackageProductSchema.extend({ productId: z.string().uuid() }))
  .max(MAX_PACKAGE_PRODUCTS)
  .refine(eachOnce((p: { productId: string }) => p.productId), { message: 'a product is repeated' });

/** Written out, as the limits schema's: this project's tsconfig infers every field optional. */
export type PackageLimitInput = { key: string; value: number | null };
export type PackageOverageInput = SetOverageInput & { key: string };
export type PackageProductInput = SetPackageProductInput & { productId: string };

export type MeterRateInput = z.infer<typeof meterRate>;
export type MeterRateEdit = z.infer<typeof meterRate> | z.infer<typeof meterRateOff>;

export const createPackageSchema = z
  .object({
    name,
    sourceLang: lang.optional(),
    description: description.optional(),
    monthlyPrice: price.optional(),
    yearlyPrice: price.optional(),
    includedFeatureKeys: featureKeys,
    meterRates: meterRates.optional(),
    limits: packageLimits.optional(),
    quotaOverages: packageOverages.optional(),
    products: packageProducts.optional(),
  })
  .strict()
  .refine((p) => p.monthlyPrice !== undefined || p.yearlyPrice !== undefined, {
    message: 'a package needs a monthly or a yearly price',
  });

export type CreatePackageInput = Omit<z.infer<typeof createPackageSchema>, 'limits' | 'quotaOverages' | 'products'> & {
  limits?: PackageLimitInput[];
  quotaOverages?: PackageOverageInput[];
  products?: PackageProductInput[];
};

/**
 * `null` clears a price; the service refuses an edit that leaves none. `isActive: false` deactivates.
 * `description: null` removes it. A new `sourceLang` says the text is now in that language, so it
 * comes with the name and the description (or `null`) written in it.
 */
export const updatePackageSchema = z
  .object({
    name: name.optional(),
    sourceLang: lang.optional(),
    description: description.nullable().optional(),
    monthlyPrice: price.nullable().optional(),
    yearlyPrice: price.nullable().optional(),
    includedFeatureKeys: featureKeys.optional(),
    isActive: z.boolean().optional(),
    meterRates: meterRateEdits.optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'nothing to change' })
  .refine((p) => p.sourceLang === undefined || (p.name !== undefined && p.description !== undefined), {
    message: 'a new sourceLang comes with name and description in it',
    path: ['sourceLang'],
  });

export type UpdatePackageInput = z.infer<typeof updatePackageSchema>;

export const listPackagesSchema = z
  .object({ active: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).optional() })
  .strict();

export type ListPackagesInput = z.infer<typeof listPackagesSchema>;

/** Package translation review (ADR-0154 decision 6): catalog's request shapes, so the panel's view serves both. */
const textKey = z.string().max(200);
const REVIEW_BATCH_MAX = 200;
export const listPackageTextsSchema = z.object({ lang: lang.optional() }).strict();
export const publishPackageTextsSchema = z.object({ lang, keys: z.array(textKey).min(1).max(REVIEW_BATCH_MAX) }).strict();
export const editPackageTextsSchema = z
  .object({ lang, texts: z.record(textKey, description) })
  .strict()
  .refine((b) => Object.keys(b.texts).length > 0 && Object.keys(b.texts).length <= REVIEW_BATCH_MAX, { message: 'texts holds 1-200 entries', path: ['texts'] });

export type ListPackageTextsInput = z.infer<typeof listPackageTextsSchema>;
export type PublishPackageTextsInput = { lang: string; keys: string[] };
export type EditPackageTextsInput = { lang: string; texts: Record<string, string> };
