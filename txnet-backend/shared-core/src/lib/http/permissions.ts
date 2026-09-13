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
