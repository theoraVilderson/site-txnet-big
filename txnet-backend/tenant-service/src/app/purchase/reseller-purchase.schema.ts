import { z } from 'zod';

import { BILLING_MODELS, slugSchema } from '../resellers/reseller.schema';

/**
 * The wire shape of buying a reseller (F-019-h). `.strict()`: the buyer names
 * the package, the period and the name they want; the owner is the caller and
 * the status the service's.
 *
 * `slug` is optional: sent, it is the buyer's own (the suggestion edited, or
 * typed); absent, the purchase takes the suggestion `name` gives.
 */

const name = z.string().trim().min(1).max(100);

export const purchaseSchema = z
  .object({
    packageId: z.string().uuid(),
    billingModel: z.enum(BILLING_MODELS),
    name,
    slug: slugSchema.optional(),
  })
  .strict();

export type PurchaseInput = z.infer<typeof purchaseSchema>;

export const suggestSlugSchema = z.object({ name }).strict();

export type SuggestSlugInput = z.infer<typeof suggestSlugSchema>;
