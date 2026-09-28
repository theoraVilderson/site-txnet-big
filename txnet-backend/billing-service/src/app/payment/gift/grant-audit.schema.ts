import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { grantListSchema } from './grant-list.schema';

const E = BackendI18nKeys.errors.billing;

/** The `reason` an admin may give an act whose body has nothing else, kept on its audit row (F-311-r). */
export const optionalReason = z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }).optional();

/**
 * The body of `…/unfreeze` and `…/rotate-token`: an optional `reason`. A bare
 * POST with no body is the same as `{}` — both routes took none before F-311-r.
 */
export const grantReasonSchema = z.object({ reason: optionalReason }).strict().default({});

export type GrantReasonBody = z.infer<typeof grantReasonSchema>;

/** `GET …/grants/:grantId/history` (F-311-r): newest first, 20 a page unless asked. */
export const grantHistorySchema = z.object({ page: grantListSchema.shape.page, pageSize: grantListSchema.shape.pageSize });

export type GrantHistoryQuery = z.infer<typeof grantHistorySchema>;
