import { TenantBillingModel } from '@prisma/client';
import { z } from 'zod';

/**
 * The wire shape of a reseller's subscription (F-018-e).
 *
 * `.strict()`: `currentPeriodEnd` is the service's to set — the trial on the
 * first package, F-019-c's renewals after — never the caller's.
 */

/**
 * D-41: subscription only, no metering. `auth-service`'s reseller schema holds
 * the twin until F-018-y moves it here, for the reason the zod pipe gives — an
 * Nx app cannot import an Nx app.
 */
export const BILLING_MODELS = [TenantBillingModel.subscription_monthly, TenantBillingModel.subscription_yearly] as const;

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
 * at once. `renewalGraceDays`: how long an unpaid renewal is waited for before
 * the reseller is suspended (F-019-c).
 */
export const updateSubscriptionSettingsSchema = z
  .object({
    trialDays: z.number().int().min(0).max(365).optional(),
    suspensionHoldDays: z.number().int().min(0).max(90).optional(),
    renewalGraceDays: z.number().int().min(0).max(30).optional(),
  })
  .strict()
  .refine((v) => v.trialDays !== undefined || v.suspensionHoldDays !== undefined || v.renewalGraceDays !== undefined, { message: 'at least one setting' });

export type UpdateSubscriptionSettingsInput = z.infer<typeof updateSubscriptionSettingsSchema>;

/**
 * More time for an unpaid reseller (F-019-g): whole days added to the later of
 * now and the time it already had, and why. `.strict()`: the deadline is the
 * service's to compute, never the caller's.
 */
export const grantGraceSchema = z
  .object({
    days: z.number().int().min(1).max(90),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type GrantGraceInput = z.infer<typeof grantGraceSchema>;
