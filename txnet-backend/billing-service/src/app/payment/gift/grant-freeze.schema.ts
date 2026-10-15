import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ADMIN_FREEZE_MODES } from '../../entitlement/freeze';
import { optionalReason } from './grant-audit.schema';

const E = BackendI18nKeys.errors.billing;

/** Who may lift it (F-0401-d): `hard` only an admin, `soft` the user too. Never `self` — that is the user's own act. */
const mode = z.enum(ADMIN_FREEZE_MODES, { message: E.configActionInvalid });

/**
 * The body of `POST …/users/:userId/grants/:grantId/freeze` (F-311-h):
 * `until`, when the freeze ends by itself — an ISO instant with its offset;
 * absent, it lasts until it is lifted. `mode` absent is `hard`, every freeze
 * from before F-0401-d (`freezeGrant` decides it, once). Whether it is in the future
 * is `freezeGrant`'s to decide (`freeze_until_not_future`), against the same
 * `now` it freezes at. `reason` is kept on its audit row (F-311-r).
 */
export const grantFreezeSchema = z
  .object({
    until: z.string({ message: E.configActionInvalid }).datetime({ offset: true, message: E.configActionInvalid }).optional(),
    mode: mode.optional(),
    reason: optionalReason,
  })
  .strict();

export type GrantFreezeBody = z.infer<typeof grantFreezeSchema>;

/** The body of `PUT …/grants/:grantId/freeze-mode` (F-0401-d): the mode a frozen Grant takes now, and the reason its history keeps. */
export const grantFreezeModeSchema = z.object({ mode, reason: optionalReason }).strict();

export type GrantFreezeModeBody = z.infer<typeof grantFreezeModeSchema>;
