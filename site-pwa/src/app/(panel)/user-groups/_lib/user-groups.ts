import type { Me } from "@/lib/auth-api";
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
const TENANT_MANAGE = "tenant.manage";

/** The schema's bounds; the spec reads both from `user-group.schema.ts`. */
export const GROUP_NAME_MAX = 80;
export const MEMBER_IDS_MAX = 500;

/**
 * Every reason auth-service refuses this page with (`UserGroupRejection`). The
 * spec reads the service's union, so a new reason does not ship without its
 * sentence.
 */
export type UserGroupRefusal =
  | "group_not_found"
  | "name_taken"
  | "platform_only"
  | "user_not_found"
  | "tenant_not_found"
  | "not_a_reseller"
  | "all_tenants_conflict"
  | "member_not_found"
  | "group_in_use";

export const REFUSAL_KEYS: Record<UserGroupRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as UserGroupRefusal] : null;
}

const holds = (me: Me | null, key: string) => holdsPermission(me?.permissions, key);
const onPlatform = (me: Me | null) => me?.tenant?.type === "platform_owner";

/** Who may open the page — the menu entry's rule, for a visitor who typed the path. */
export const canManageGroups = (me: Me | null) => holds(me, USER_GROUP_MANAGE);

/**
 * Resellers as members, and "every reseller", are the platform owner's alone
 * (`platform_only`). The tenant type decides, never `*`: a reseller
 * administers its own roles and can hold every key.
 */
export const canNameResellers = (me: Me | null) => onPlatform(me);

/**
 * How the caller finds a user to add. The group routes do not search; each
 * tenant has its own door to its users, and neither is `user_group.manage`:
 * - `platform` — `GET /auth/users` (`user.search`, platform owner);
 * - `reseller` — `GET /auth/tenants/:own/users` (`ResellerAccess`: the owner,
 *   or a seat holding `tenant.manage`);
 * - `ids` — neither: the ids are typed.
 */
export type MemberSearch = "platform" | "reseller" | "ids";
export function memberSearchOf(me: Me | null): MemberSearch {
  if (!me) return "ids";
  if (onPlatform(me)) return holds(me, USER_SEARCH) ? "platform" : "ids";
  return me.tenant.isOwner || holds(me, TENANT_MANAGE) ? "reseller" : "ids";
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
export function createGroupBody(form: GroupForm, me: Me | null): { name: string; allTenants?: boolean } {
  const name = form.name.trim();
  return canNameResellers(me) ? { name, allTenants: form.allTenants } : { name };
}

/**
 * Only what changed — the schema refuses an empty patch, so an edit that
 * restates everything answers `null` and is not sent.
 */
export function updateGroupBody(form: GroupForm, was: GroupForm, me: Me | null): { name?: string; allTenants?: boolean } | null {
  const body: { name?: string; allTenants?: boolean } = {};
  const name = form.name.trim();
  if (name !== was.name) body.name = name;
  if (canNameResellers(me) && form.allTenants !== was.allTenants) body.allTenants = form.allTenants;
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
 */
export function membersBody(userIds: readonly string[], tenantIds: readonly string[], me: Me | null): { userIds?: string[]; tenantIds?: string[] } | null {
  const tenants = canNameResellers(me) ? tenantIds : [];
  if (userIds.length > MEMBER_IDS_MAX || tenants.length > MEMBER_IDS_MAX) throw new Error(`at most ${MEMBER_IDS_MAX} ids of each`);
  const body: { userIds?: string[]; tenantIds?: string[] } = {};
  if (userIds.length > 0) body.userIds = [...userIds];
  if (tenants.length > 0) body.tenantIds = [...tenants];
  return Object.keys(body).length > 0 ? body : null;
}
