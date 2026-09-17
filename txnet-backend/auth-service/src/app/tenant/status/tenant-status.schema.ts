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
  })
  .strict();

export type ChangeTenantStatusInput = z.infer<typeof changeTenantStatusSchema>;
