/**
 * The permission that stands for every other one (F-101-d, ADR-0043 as
 * amended). `SuperAdmin` holds it instead of a list, so a permission a new
 * feature adds reaches that role without anyone editing a grant.
 *
 * Only the bare `*` is a wildcard; `user.*` is an ordinary, unmatched name.
 * `auth-handler`'s `RolePolicy.Allows` gives it the same meaning, and the
 * policy file is still the ceiling: a role whose entry lacks `*` is refused
 * the moment its token claims it.
 */
export const ALL_PERMISSIONS = '*';

/**
 * Whether a caller holding `held` may do `key`. Every TypeScript permission
 * check goes through this — `tools/contracts.py` fails on a bare
 * `permissions.includes(...)` — so what `*` means is decided in one place.
 */
export function holdsPermission(
  held: readonly string[] | undefined,
  key: string,
): boolean {
  return !!held && (held.includes(ALL_PERMISSIONS) || held.includes(key));
}

/** What a token was minted with: the role it names and its fingerprint, when it has one. */
export interface PermissionGrant {
  roleId: string;
  permHash?: string;
}

/** What Redis holds now (ADR-0043, ADR-0138); `null` or `''` where it knows nothing. */
export interface PermissionState {
  roleHash: string | null;
  currentRole: string | null;
  personHash: string | null;
}

/**
 * Whether what a token says its holder may do is no longer true: they hold
 * another role now, or their answer has a new fingerprint — their own when
 * they have one (ADR-0138), else their role's (ADR-0043). `auth-handler`'s
 * `stalePermissions` asks the same; `AuthGuard` and the gateway's socket tick
 * (RT-1-n) ask it here.
 *
 * **A missing key is not a change.** An empty keyspace, a flush, or a role
 * Postgres has not yet reported refuses nobody; the session check is the one
 * that fails closed.
 */
export function permissionsStale(grant: PermissionGrant, now: PermissionState): boolean {
  if (now.currentRole && now.currentRole !== grant.roleId) return true;
  const currentHash = now.personHash || now.roleHash;
  return !!currentHash && currentHash !== (grant.permHash ?? '');
}
