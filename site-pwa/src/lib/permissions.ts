/**
 * The permission that stands for every other one (F-101-d, ADR-0043 as
 * amended): `SuperAdmin` holds it instead of a list. The panel's twin of
 * shared-core's `ALL_PERMISSIONS` — the panel does not import shared-core.
 * Only the bare `*` is a wildcard; `user.*` is an ordinary, unmatched name.
 */
export const ALL_PERMISSIONS = "*";

/**
 * Whether a session holding `held` may do `key`. Every panel permission check
 * goes through this or `holdsEveryPermission` — `tools/contracts.py` fails on a
 * bare `permissions.includes(...)` — so what `*` means is decided in one place.
 * A check that bypasses it hid the platform's currency card from SuperAdmin
 * (2026-09-28).
 */
export function holdsPermission(held: readonly string[] | null | undefined, key: string): boolean {
  return !!held && (held.includes(ALL_PERMISSIONS) || held.includes(key));
}

/** Every key in `keys`, or `*`. An empty `keys` asks for nothing and is met. */
export function holdsEveryPermission(held: readonly string[] | null | undefined, keys: readonly string[]): boolean {
  return !!held && (held.includes(ALL_PERMISSIONS) || keys.every((key) => held.includes(key)));
}
