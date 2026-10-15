import { holdsPermission } from '@txnet-backend/shared-core';

/** The access token's claims, read without a check — `null` when unreadable. */
function claimsOf(accessToken: string): Record<string, unknown> | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether an access token belongs to a restricted account (ADR-0133).
 *
 * Read only to choose which menu a chat sees — never verified here, and never
 * a boundary: the gate and `AuthGuard` refuse a restricted token anything but
 * support whatever this answers. An unreadable token reads as not restricted,
 * so the worst a wrong answer costs is a menu whose taps are refused.
 */
export function isRestrictedToken(accessToken: string): boolean {
  return claimsOf(accessToken)?.['restricted'] === true;
}

/**
 * Whether the token carries `key` (`*` included) — read, like the mark above,
 * only to choose a menu row (F-805-b): billing refuses every tap of a person
 * without it, whatever this answers.
 */
export function tokenHolds(accessToken: string, key: string): boolean {
  const permissions = claimsOf(accessToken)?.['permissions'];
  return Array.isArray(permissions) && holdsPermission(permissions.filter((p): p is string => typeof p === 'string'), key);
}
