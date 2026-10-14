import { ForbiddenException } from '@nestjs/common';
import { BackendI18nKeys, holdsPermission } from '@txnet-backend/shared-core';

/** The answer a one-factor door gives the holder of `*` (ADR-0145). */
export const OWNER_NEEDS_BOTH_FACTORS = BackendI18nKeys.errors.auth.ownerNeedsBothFactors;

/** The code step has no number to send to: refused, never a failed send (ADR-0145). */
export const SECOND_FACTOR_UNAVAILABLE = BackendI18nKeys.errors.auth.secondFactorUnavailable;

/**
 * ADR-0145 (1), (4): whose sign-in needs the password and then a code — whoever
 * holds `*`, read from their whole answer (`AccessReader`), never a role name.
 */
export function needsBothFactors(answer: { keys: readonly string[] }): boolean {
  return holdsPermission(answer.keys, '*');
}

/**
 * The same question without a read, for a fallback that picks among members: `*`
 * comes only from a role (groups never give it, ADR-0138 (7)), so the role answers.
 */
export function roleGivesEverything(user: { role?: { rolePermissions?: { permission: { key: string } }[] } | null } | null): boolean {
  return holdsPermission(user?.role?.rolePermissions?.map((rp) => rp.permission.key) ?? [], '*');
}

/**
 * Thrown where a door proving one factor would mint a session for such a
 * person — a handoff, the messenger, a switch, registration (ADR-0145 (2)).
 */
export class OwnerNeedsBothFactors extends ForbiddenException {
  constructor() {
    super({ i18nKey: OWNER_NEEDS_BOTH_FACTORS });
  }
}
