import { z } from 'zod';

/**
 * The wire shape of a reseller's status change (F-018-f).
 *
 * `trial` is not offered: a tenant starts there and leaves it. `.strict()`:
 * `suspendedAt` and `graceEndsAt` are the service's to stamp, never the caller's.
 */
export const CHANGEABLE_STATUSES = ['active', 'suspended', 'terminated'] as const;

export const changeTenantStatusSchema = z
  .object({
    status: z.enum(CHANGEABLE_STATUSES),
    reason: z.string().trim().min(1).max(500).optional(),
    /** F-018-q: stop the reseller's `sending` campaigns too. Absent = they finish. Meaningless when reactivating, so refused there. */
    stopCampaigns: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.stopCampaigns === undefined || b.status !== 'active', { path: ['stopCampaigns'], message: 'only with suspended or terminated' });

export type ChangeTenantStatusInput = z.infer<typeof changeTenantStatusSchema>;
