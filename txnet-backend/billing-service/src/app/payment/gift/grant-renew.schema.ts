import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants/:grantId/renew` (F-311-d):
 * `requestId`, the caller's own id for this one renewal — minted once per
 * confirm, so a double click answers the first renewal instead of giving a
 * second period. With neither `gb` nor `days` it is one period of the plan the
 * user bought (user, 2026-09-28); with either, that amount (the other 0):
 * `gb` ≥ 0 GiB, fractions allowed, at most 100 000; `days` a whole 0..3650.
 * Whether the Grant takes bytes at all is `renewGrant`'s to decide.
 */
export const grantRenewSchema = z
  .object({
    requestId: z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid }),
    gb: z.number({ message: E.configActionInvalid }).finite({ message: E.configActionInvalid }).min(0, { message: E.configActionInvalid }).max(100_000, { message: E.configActionInvalid }).optional(),
    days: z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(0, { message: E.configActionInvalid }).max(3650, { message: E.configActionInvalid }).optional(),
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }).optional(),
  })
  .strict();

export type GrantRenewBody = z.infer<typeof grantRenewSchema>;
