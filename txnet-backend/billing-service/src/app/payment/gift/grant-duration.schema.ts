import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants/:grantId/duration` (F-311-i):
 * exactly one of `days` (±, whole, never 0, at most ten years either way) or
 * `endsAt` (an ISO instant with its offset), and the `reason` written into the
 * Grant's history. Whether the new end is in the future is
 * `changeGrantDuration`'s to decide, against the same `now` it moves at.
 */
export const grantDurationSchema = z
  .object({
    days: z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(-3650).max(3650).refine((d) => d !== 0, { message: E.configActionInvalid }).optional(),
    endsAt: z.string({ message: E.configActionInvalid }).datetime({ offset: true, message: E.configActionInvalid }).optional(),
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }),
  })
  .strict()
  .refine((b) => (b.days === undefined) !== (b.endsAt === undefined), { message: E.configActionInvalid });

export type GrantDurationBody = z.infer<typeof grantDurationSchema>;
