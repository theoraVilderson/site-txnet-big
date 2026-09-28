import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST …/users/:userId/grants` (F-311-o): the variant to issue,
 * and `requestId`, the caller's own id for this one request — minted once per
 * confirm, so a double click or a repeated bot callback answers the Grant the
 * first one issued instead of issuing a second.
 */
export const grantIssueSchema = z
  .object({
    variantId: z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid }),
    requestId: z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid }),
  })
  .strict();

export type GrantIssueBody = z.infer<typeof grantIssueSchema>;
