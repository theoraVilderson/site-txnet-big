import { z } from 'zod';
import { BILLING_MODELS } from '../admin/tenant-admin.schema';

/**
 * The wire shape of a reseller's subscription (F-018-e).
 *
 * `.strict()`: `currentPeriodEnd` is the service's to set — the trial on the
 * first package, F-019-c's renewals after — never the caller's.
 */

export const putSubscriptionSchema = z
  .object({
    packageId: z.string().uuid(),
    billingModel: z.enum(BILLING_MODELS),
  })
  .strict();

export type PutSubscriptionInput = z.infer<typeof putSubscriptionSchema>;

/** Whole days; 0 means the first period ends, and is charged, at once (F-019-c). */
export const updateSubscriptionSettingsSchema = z
  .object({ trialDays: z.number().int().min(0).max(365) })
  .strict();

export type UpdateSubscriptionSettingsInput = z.infer<typeof updateSubscriptionSettingsSchema>;
