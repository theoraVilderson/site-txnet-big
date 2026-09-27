import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants/:grantId/freeze` (F-311-h):
 * `until`, when the freeze ends by itself — an ISO instant with its offset;
 * absent, it lasts until an admin unfreezes it. Whether it is in the future
 * is `freezeGrant`'s to decide (`freeze_until_not_future`), against the same
 * `now` it freezes at.
 */
export const grantFreezeSchema = z
  .object({
    until: z.string({ message: E.configActionInvalid }).datetime({ offset: true, message: E.configActionInvalid }).optional(),
  })
  .strict();

export type GrantFreezeBody = z.infer<typeof grantFreezeSchema>;
