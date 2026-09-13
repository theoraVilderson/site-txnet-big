import { createHash } from 'crypto';

/**
 * The fingerprint of one permission set (ADR-0043).
 *
 * Minted into every access token as `permHash`, and written per role to Redis
 * when Postgres reports a change, so the gate can tell a token whose role has
 * moved on from one that is still current. Both sides call this one function:
 * a second spelling of it would read as every token being stale at once.
 *
 * A content hash rather than a counter, so two writers cannot race it and a set
 * put back the way it was restores the fingerprint tokens already carry. The
 * keys are de-duplicated and sorted first: the order rows come back from
 * Postgres is not a change to what a role may do.
 */
export function permissionFingerprint(keys: readonly string[]): string {
  const canonical = [...new Set(keys)].sort().join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
