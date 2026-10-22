import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { MAX_SELF_MOVE_COOLDOWN_HOURS } from './self-move-setting';

const E = BackendI18nKeys.errors.billing;

/**
 * `PUT …/self-move-settings` and `…/self-move-settings/products/:productId`
 * (F-410-a): one layer's own values, null = inherit. Both keys are required,
 * so an empty body changes nothing by accident.
 */
export const selfMoveOwnSchema = z
  .object({
    enabled: z.boolean({ message: E.selfMoveSettingsInvalid }).nullable(),
    cooldownHours: z
      .number({ message: E.selfMoveSettingsInvalid })
      .int({ message: E.selfMoveSettingsInvalid })
      .min(0, { message: E.selfMoveSettingsInvalid })
      .max(MAX_SELF_MOVE_COOLDOWN_HOURS, { message: E.selfMoveSettingsInvalid })
      .nullable(),
  })
  .strict();

export type SelfMoveOwnBody = z.infer<typeof selfMoveOwnSchema>;
