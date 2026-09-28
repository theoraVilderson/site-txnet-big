import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants/:grantId/delete` (F-311-m):
 * `refund`, the admin's answer — give the unserved remainder back to the
 * wallet (F-027-r) or not (e.g. fraud) — asked every time, never defaulted;
 * and the `reason` the `grant_deletion` row keeps with it.
 */
export const grantDeleteSchema = z
  .object({
    refund: z.boolean({ message: E.configActionInvalid }),
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }),
  })
  .strict();

export type GrantDeleteBody = z.infer<typeof grantDeleteSchema>;
