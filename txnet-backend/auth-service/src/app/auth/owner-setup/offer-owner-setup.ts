import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { ok } from '../../common/response/response.util';

/**
 * F-0102: the password step's answer for an owner still on the seed's account —
 * a setup token and no session. `null` for every other account. Its own file,
 * like `owner-factors.ts`: `AuthService` calls it, and `OwnerSetupService`
 * injects `AuthService`.
 */
export function offerOwnerSetup(user: { id: string; setupRequired: boolean }, tokens: { signSetupToken(userId: string): string }) {
  if (!user.setupRequired) return null;
  return ok({ setupRequired: true, setupToken: tokens.signSetupToken(user.id) }, BackendI18nKeys.errors.auth.ownerSetupRequired);
}
