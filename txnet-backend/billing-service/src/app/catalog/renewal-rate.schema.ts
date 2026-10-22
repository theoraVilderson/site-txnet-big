import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { UNIT_PRICE, instant } from './catalog-admin.schema';

/** The most GiB one renewal may be set to sell — a typo guard, as `MAX_SALES_CAP` is. */
export const RENEWAL_GIB_MAX = 100_000;
/** The most days one renewal may be set to sell: ten years. */
export const RENEWAL_DAYS_MAX = 3_650;

const unitPrice = (what: string) => z.string({ message: `${what} must be a decimal string` }).regex(UNIT_PRICE, { message: `${what} must be a decimal string` });
const bound = (max: number) => z.number().int().min(0).max(max);

/**
 * A product's renewal rate from `effectiveFrom` on (F-305-b, ADR-0158 (4)):
 * GiB and days a user types are priced per unit, within these bounds. A part
 * not sold has a maximum of 0; a part sold costs more than 0 — the same rules
 * the table's CHECKs hold, refused here first with a reason a form can show.
 */
export const setRenewalRateSchema = z
  .object({
    pricePerGib: unitPrice('pricePerGib'),
    pricePerDay: unitPrice('pricePerDay'),
    minGib: bound(RENEWAL_GIB_MAX),
    maxGib: bound(RENEWAL_GIB_MAX),
    minDays: bound(RENEWAL_DAYS_MAX),
    maxDays: bound(RENEWAL_DAYS_MAX),
    effectiveFrom: instant('effectiveFrom').optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.minGib > r.maxGib || r.minDays > r.maxDays) ctx.addIssue({ code: 'custom', message: 'renewal_bounds_reversed' });
    if (r.maxGib === 0 && r.maxDays === 0) ctx.addIssue({ code: 'custom', message: 'renewal_sells_nothing' });
    const free = (price: string, max: number) => max > 0 && new Prisma.Decimal(price).isZero();
    if (free(r.pricePerGib, r.maxGib) || free(r.pricePerDay, r.maxDays)) ctx.addIssue({ code: 'custom', message: 'renewal_sold_part_free' });
  });

/** Custom renewal switched off from `effectiveFrom` (absent = now): a row with no rate. */
export const offRenewalRateSchema = z.object({ effectiveFrom: instant('effectiveFrom').optional() }).strict();

export type SetRenewalRateBody = z.infer<typeof setRenewalRateSchema>;
export type OffRenewalRateBody = z.infer<typeof offRenewalRateSchema>;
