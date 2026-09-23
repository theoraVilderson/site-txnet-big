import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_BULK_CONFIGS, USER_CONFIG_ACTIONS } from './user-configs';

const E = BackendI18nKeys.errors.billing;

/**
 * The body of `POST /api/billing/traffic/configs/actions` (F-027-ac): one
 * action, and the configs to take it on. A single config is a list of one —
 * one route, so the per-config outcome is the same shape either way.
 * Whose configs is not here: the user is the gate's `X-User-Id`.
 */
export const configActionSchema = z.object({
  action: z.enum(USER_CONFIG_ACTIONS, { message: E.configActionInvalid }),
  configIds: z
    .array(z.string().uuid({ message: E.configActionInvalid }), { message: E.configActionInvalid })
    .min(1, { message: E.configActionInvalid })
    .max(MAX_BULK_CONFIGS, { message: E.configActionInvalid }),
});

export type ConfigActionBody = z.infer<typeof configActionSchema>;
