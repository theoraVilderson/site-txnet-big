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

/**
 * Whole days, at least one field. `trialDays`: 0 means the first period ends,
 * and is charged, at once (F-019-c). `suspensionHoldDays`: how long a
 * suspended tenant's `/sub` links are still served (F-018-f); 0 refuses them
 * at once.
 */
export const updateSubscriptionSettingsSchema = z
  .object({
    trialDays: z.number().int().min(0).max(365).optional(),
    suspensionHoldDays: z.number().int().min(0).max(90).optional(),
  })
  .strict()
  .refine((v) => v.trialDays !== undefined || v.suspensionHoldDays !== undefined, { message: 'at least one setting' });

export type UpdateSubscriptionSettingsInput = z.infer<typeof updateSubscriptionSettingsSchema>;
