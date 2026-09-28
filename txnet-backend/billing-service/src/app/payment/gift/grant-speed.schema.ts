import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants/:grantId/speed` (F-311-p): `mbps`,
 * the cap both ways in whole megabits per second (1..100 000, the column's
 * CHECK), or `null` to lift it; `reason` as on every admin write here.
 */
export const grantSpeedSchema = z
  .object({
    mbps: z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(1, { message: E.configActionInvalid }).max(100_000, { message: E.configActionInvalid }).nullable(),
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }),
  })
  .strict();

export type GrantSpeedBody = z.infer<typeof grantSpeedSchema>;
