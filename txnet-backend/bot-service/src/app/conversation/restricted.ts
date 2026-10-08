/**
 * Whether an access token belongs to a restricted account (ADR-0133).
 *
 * Read only to choose which menu a chat sees — never verified here, and never
 * a boundary: the gate and `AuthGuard` refuse a restricted token anything but
 * support whatever this answers. An unreadable token reads as not restricted,
 * so the worst a wrong answer costs is a menu whose taps are refused.
 */
export function isRestrictedToken(accessToken: string): boolean {
  const payload = accessToken.split('.')[1];
  if (!payload) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.restricted === true;
  } catch {
    return false;
  }
}
