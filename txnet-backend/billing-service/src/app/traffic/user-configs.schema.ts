import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_CONFIG_LABEL_LENGTH } from './line-names';
import { ADMIN_CONFIG_ACTIONS, MAX_BULK_CONFIGS, USER_CONFIG_ACTIONS } from './user-configs';

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

/**
 * The body of `PUT /api/billing/traffic/configs/:configId/label` (F-307-g):
 * the buyer's name, trimmed, 1..40 characters. An empty or `null` label is
 * the default name again (ADR-0089 rule 5).
 */
export const configLabelSchema = z.object({
  label: z
    .string({ message: E.configLabelInvalid })
    .trim()
    .max(MAX_CONFIG_LABEL_LENGTH, { message: E.configLabelInvalid })
    .nullable()
    .transform((label) => (label === '' ? null : label)),
});

export type ConfigLabelBody = z.infer<typeof configLabelSchema>;

/**
 * The body of `POST /api/billing/tenants/:tenantId/users/:userId/configs/actions`
 * (F-311-g): an admin's action on 1..50 of that user's configs. A disable
 * carries its `reason` (it is the config's `disabledReason`); a move names
 * its target panel, and nothing else does.
 */
export const adminConfigActionSchema = z
  .object({
    action: z.enum(ADMIN_CONFIG_ACTIONS, { message: E.configActionInvalid }),
    configIds: configActionSchema.shape.configIds,
    reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(200, { message: E.configActionInvalid }).optional(),
    toPanelId: z.string().uuid({ message: E.configActionInvalid }).optional(),
  })
  .refine((b) => (b.action === 'disable') === (b.reason !== undefined), { message: E.configActionInvalid, path: ['reason'] })
  .refine((b) => (b.action === 'move') === (b.toPanelId !== undefined), { message: E.configActionInvalid, path: ['toPanelId'] });

export type AdminConfigActionBody = z.infer<typeof adminConfigActionSchema>;
