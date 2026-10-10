import type { GroupPreset, Me, PermissionArea, UserGroupAccess, UserGroupMember } from "@/lib/auth-api";
import { groupsApiPath } from "@/lib/auth-api";
import { endOfDay } from "../../my-resellers/_lib/team";
import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";

/** The page's strings as generated constants (C-06). */
export const USER_GROUP_KEYS = FrontendI18nKeys.common.userGroups;
const K = USER_GROUP_KEYS;

/** The key every `/auth/user-groups` route gates on; the spec reads it from the controller. */
export const USER_GROUP_MANAGE = "user_group.manage";
/** The key the platform owner's user search gates on (F-018-ad). */
const USER_SEARCH = "user.search";
/** A reseller seat that holds this passes `ResellerAccess` for its own users (F-311-a). */
const USER_READ = "user.read";

/** The schema's bounds; the spec reads both from `user-group.schema.ts`. */
export const GROUP_NAME_MAX = 80;
export const MEMBER_IDS_MAX = 500;

/**
 * Every reason auth-service refuses this page with (`UserGroupRejection`). The
 * spec reads the service's union, so a new reason does not ship without its
 * sentence.
 */
export { groupsApiPath };

export type UserGroupRefusal =
  | "group_not_found"
  | "name_taken"
  | "platform_only"
  | "user_not_found"
  | "tenant_not_found"
  | "not_a_reseller"
  | "all_tenants_conflict"
  | "member_not_found"
  | "group_in_use"
  | "access_on_resellers"
  | "role_not_found"
  | "key_unknown"
  | "key_not_grantable"
  | "key_not_held"
  | "no_authority"
  | "expiry_past";

export const REFUSAL_KEYS: Record<UserGroupRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as UserGroupRefusal] : null;
}

const holds = (me: Me | null, key: string) => holdsPermission(me?.permissions, key);
const onPlatform = (me: Me | null) => me?.tenant?.type === "platform_owner";

/**
 * Who may open the page — the menu entry's rule, for a visitor who typed the
 * path. A tenant's page by its path is `ResellerAccess`'s to admit (GR-1-d):
 * the page asks, and shows its refusal.
 */
export const canManageGroups = (me: Me | null, tenantId: string | null = null) => (tenantId === null ? holds(me, USER_GROUP_MANAGE) : me !== null);

/**
 * Resellers as members, and "every reseller", are the platform owner's alone
 * (`platform_only`), on its own groups. The tenant type decides, never `*`: a
 * reseller administers its own access and can hold every key.
 */
export const canNameResellers = (me: Me | null, tenantId: string | null = null) => isPlatformGroup(me, tenantId);

/**
 * How the caller finds a user to add. The group routes do not search; each
 * tenant has its own door to its users, and neither is `user_group.manage`:
 * - `platform` — `GET /auth/users` (`user.search`, platform owner);
 * - `reseller` — `GET /auth/tenants/:own/users` (`ResellerAccess`: the owner,
 *   or a seat holding `user.read`, AC-1-e2);
 * - `ids` — neither: the ids are typed.
 */
export type MemberSearch = "platform" | "reseller" | "ids";
export function memberSearchOf(me: Me | null, tenantId: string | null = null): MemberSearch {
  if (!me) return "ids";
  // A tenant's page by its path searches that tenant's users, through the same door the page came in by.
  if (tenantId !== null && tenantId !== me.tenant.id) return "reseller";
  if (onPlatform(me)) return holds(me, USER_SEARCH) ? "platform" : "ids";
  return me.tenant.isOwner || holds(me, USER_READ) ? "reseller" : "ids";
}

// ------------------------------------------------------------------- the group

export type GroupForm = { name: string; allTenants: boolean };
export type Errors<T> = Partial<Record<keyof T, string>>;

export const emptyGroupForm: GroupForm = { name: "", allTenants: false };

export function validateGroupForm(form: GroupForm): Errors<GroupForm> {
  const name = form.name.trim();
  if (!name) return { name: K.errors.nameRequired };
  if (name.length > GROUP_NAME_MAX) return { name: K.errors.nameTooLong };
  return {};
}

/** The create body; `allTenants` only from the platform owner. Call after {@link validateGroupForm}. */
export function createGroupBody(form: GroupForm, me: Me | null, tenantId: string | null = null): { name: string; allTenants?: boolean } {
  const name = form.name.trim();
  return canNameResellers(me, tenantId) ? { name, allTenants: form.allTenants } : { name };
}

/**
 * Only what changed — the schema refuses an empty patch, so an edit that
 * restates everything answers `null` and is not sent.
 */
export function updateGroupBody(form: GroupForm, was: GroupForm, me: Me | null, tenantId: string | null = null): { name?: string; allTenants?: boolean } | null {
  const body: { name?: string; allTenants?: boolean } = {};
  const name = form.name.trim();
  if (name !== was.name) body.name = name;
  if (canNameResellers(me, tenantId) && form.allTenants !== was.allTenants) body.allTenants = form.allTenants;
  return Object.keys(body).length > 0 ? body : null;
}

// ----------------------------------------------------------------- the members

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Typed ids, split on spaces, commas or lines, each once; anything not a uuid is `bad`. */
export function parseIds(text: string): { ids: string[]; bad: string[] } {
  const ids: string[] = [];
  const bad: string[] = [];
  for (const token of text.split(/[\s,،]+/).filter(Boolean)) {
    const id = token.toLowerCase();
    if (!UUID.test(id)) bad.push(token);
    else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, bad };
}

/**
 * The add body, or `null` when it names no one. A reseller's reseller ids are
 * dropped — the field is never shown to it. More than {@link MEMBER_IDS_MAX}
 * of either is a caller bug: the form says so before this is reached.
 * `endDay` (`YYYY-MM-DD`) ends every membership the call adds at that day's
 * last moment (GR-1-c); none, and they last until removed.
 */
export function membersBody(
  userIds: readonly string[],
  tenantIds: readonly string[],
  me: Me | null,
  endDay: string | null = null,
  tenantId: string | null = null,
): { userIds?: string[]; tenantIds?: string[]; expiresAt?: string } | null {
  const tenants = canNameResellers(me, tenantId) ? tenantIds : [];
  if (userIds.length > MEMBER_IDS_MAX || tenants.length > MEMBER_IDS_MAX) throw new Error(`at most ${MEMBER_IDS_MAX} ids of each`);
  const body: { userIds?: string[]; tenantIds?: string[]; expiresAt?: string } = {};
  if (userIds.length > 0) body.userIds = [...userIds];
  if (tenants.length > 0) body.tenantIds = [...tenants];
  if (Object.keys(body).length === 0) return null;
  if (endDay) body.expiresAt = endOfDay(endDay);
  return body;
}

/** A member's end moved to a day's last moment, or cleared (`PATCH …/members/users/:userId`). */
export const endBody = (day: string | null): { expiresAt: string | null } => ({ expiresAt: day ? endOfDay(day) : null });

// ------------------------------------------------------------------ the access

/** The schema's cap on a group's extra keys (`setUserGroupAccessSchema`); the spec reads it. */
export const ACCESS_KEYS_MAX = 200;

/**
 * What a group gives, as the keys ticked on it (ADR-0139 (1)): its own keys,
 * plus the keys of a role an older group was given (AC-1-o) — the sheet
 * shows them all as ticks, and the panel never picks a role.
 */
export const givenKeys = (was: UserGroupAccess, roleKeys: readonly string[]) => [...new Set([...roleKeys, ...was.keys])].sort();

/**
 * The `PUT …/access` body — the **whole** set (AC-1-m), keys once each and
 * sorted, and never a role: a role the group held is folded into its keys
 * the first time it is saved. `null` when it restates what the group already
 * gives, so an untouched sheet sends nothing.
 */
export function accessBody(was: UserGroupAccess, roleKeys: readonly string[], keys: readonly string[]): { roleId: null; keys: string[] } | null {
  const next = [...new Set(keys)].sort();
  if (next.length > ACCESS_KEYS_MAX) throw new Error(`at most ${ACCESS_KEYS_MAX} keys`);
  const same = next.join() === givenKeys(was, roleKeys).join();
  return same ? null : { roleId: null, keys: next };
}

/**
 * The platform's own group — the session's on the platform, or the platform
 * by its path — the one group that may give a `platform.` key, and only to
 * the platform's own users (GR-1-e, ADR-0139 (4)).
 */
export const isPlatformGroup = (me: Me | null, tenantId: string | null) => onPlatform(me) && (tenantId === null || tenantId === me?.tenant.id);

/** The registry as a group's sheet offers it: a `platform.` key only on the platform's own group. */
export function groupKeyAreas(registry: readonly PermissionArea[], platformGroup: boolean): PermissionArea[] {
  if (platformGroup) return [...registry];
  return registry
    .map((area) => ({ ...area, permissions: area.permissions.filter((p) => !p.platformOnly) }))
    .filter((area) => area.permissions.length > 0);
}

/** Whether the group gives anything: a role or one key. */
export const givesAccess = (a: UserGroupAccess) => a.roleId !== null || a.keys.length > 0;

/**
 * The members who receive what the group gives: its own tenant's users
 * (`receivesAccess`). A reseller, or another tenant's user in the platform's
 * group, gets nothing (governance `contract.md`).
 */
export function receivers(members: readonly UserGroupMember[]): UserGroupMember[] {
  return members.filter((m) => m.memberType === "user" && m.receivesAccess);
}

// ----------------------------------------------------------------- the presets

/** Keys no preset fills: every user holds `self.` already, and `platform.` is ticked by hand. */
const NEVER_PRESET = (key: string) => key.startsWith("self.") || key.startsWith("platform.");

/**
 * What a preset fills the create wizard's keys with (GR-1-h): its keys that
 * this creator can give on this group — offered in `areas` (already
 * {@link groupKeyAreas}) and held per `grantable` (`*` = every key) — and the
 * ones it had to leave out, so the wizard can say so instead of sending a
 * key the server refuses `key_not_held`. The admin preset is every such key,
 * never a `platform.` or `self.` one. `null` (from scratch) fills nothing.
 */
export function presetDraft(preset: GroupPreset | null, areas: readonly PermissionArea[], grantable: readonly string[]): { keys: string[]; dropped: string[] } {
  if (!preset) return { keys: [], dropped: [] };
  const offered = new Set(areas.flatMap((a) => a.permissions.filter((p) => !p.platformOnly).map((p) => p.key)));
  const can = (key: string) => offered.has(key) && holdsPermission(grantable, key);
  if (preset.every) return { keys: [...offered].filter((k) => !NEVER_PRESET(k) && can(k)).sort(), dropped: [] };
  const keys = [...new Set(preset.keys)].sort();
  return { keys: keys.filter(can), dropped: keys.filter((k) => !can(k)) };
}
