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

/**
 * Every key that opens a reseller surface to one of its own staff (AC-1-e,
 * AC-1-e2) — the panel's twin of shared-core's `RESELLER_KEYS`, which the API's
 * member door reads. `permissions.test.ts` fails when the two lists differ.
 */
export const RESELLER_KEYS = [
  "audit.read",
  "bot.manage",
  "campaign.manage",
  "catalog.manage",
  "credential.manage",
  "domain.manage",
  "export.request",
  "gateway.manage",
  "grant.assign",
  "grant.compensate",
  "grant.read",
  "grant.repair",
  "report.read",
  "restriction.assign",
  "role.manage",
  "settings.manage",
  "staff.manage",
  "theme.manage",
  "user.impersonate",
  "user.read",
  "user.write",
  "user_group.manage",
  "wallet.manual_adjust",
] as const;

/** Any one reseller key, or `*`: a seat that administers some part of its reseller. */
export function holdsAnyResellerKey(held: readonly string[] | null | undefined): boolean {
  return RESELLER_KEYS.some((key) => holdsPermission(held, key));
}
