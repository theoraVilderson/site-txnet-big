/**
 * Everything that decides what one person may do (ADR-0138). `groups` holds
 * only the groups that give this person access — their own tenant's, with a
 * role or keys on it; the reader filters, this function trusts the list.
 */
export type AccessSources = {
  roleKeys: readonly string[];
  groups?: readonly { roleKeys: readonly string[]; keys: readonly string[] }[];
  given?: readonly string[];
  taken?: readonly string[];
};

/**
 * The answer: the keys a token carries, and whether anything beyond the role
 * applies — the one case the gate compares a per-person fingerprint for.
 */
export type UserAccess = { keys: string[]; personal: boolean };

const WILDCARD = '*';

/**
 * One answer for what a person may do (AC-1-k, ADR-0138): the role's keys,
 * plus every group's role keys and extra keys, plus the keys given to them,
 * minus the keys taken from them. **A removal wins** over every source, the
 * role included (user, 2026-10-08).
 *
 * `*` is the role's alone: a `*` role is neither widened nor narrowed (there
 * is no spelling for "everything but one"), and `*` from any other source is
 * dropped, so no write outside the role table can mint a wildcard.
 *
 * Pure, so `TokenService`, the Redis writer and the authority rule cannot
 * disagree about it.
 */
export function accessOf(sources: AccessSources): UserAccess {
  const roleKeys = [...new Set(sources.roleKeys)];
  if (roleKeys.includes(WILDCARD)) return { keys: roleKeys, personal: false };

  const groups = sources.groups ?? [];
  const given = sources.given ?? [];
  const taken = new Set(sources.taken ?? []);
  const personal = groups.length > 0 || given.length > 0 || taken.size > 0;
  if (!personal) return { keys: roleKeys, personal: false };

  const keys = new Set(roleKeys);
  for (const group of groups) for (const key of [...group.roleKeys, ...group.keys]) keys.add(key);
  for (const key of given) keys.add(key);
  keys.delete(WILDCARD);
  for (const key of taken) keys.delete(key);
  return { keys: [...keys], personal: true };
}
