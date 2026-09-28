import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants/:grantId/devices` (F-311-q):
 * `limit`, how many devices (distinct addresses at once) the Grant may use,
 * 1..1000, or `null` to lift it; `reason` as on every admin write here.
 */
export const grantDevicesSchema = z
  .object({
    limit: z.number({ message: E.configActionInvalid }).int({ message: E.configActionInvalid }).min(1, { message: E.configActionInvalid }).max(1000, { message: E.configActionInvalid }).nullable(),
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }),
  })
  .strict();

export type GrantDevicesBody = z.infer<typeof grantDevicesSchema>;
