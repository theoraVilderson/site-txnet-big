import type { GroupPreset, Me, MemberChangesBody, PermissionArea, UserGroupAccess, UserGroupMember } from "@/lib/auth-api";
import { groupsApiPath } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { isPlatformTenant } from "@/lib/tenant-type";

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
  | "expiry_past"
  | "member_conflict";

export const REFUSAL_KEYS: Record<UserGroupRefusal, string> = K.refusals;

/** The refusal's own sentence key, when the service named one this page knows. */
export function refusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in REFUSAL_KEYS ? REFUSAL_KEYS[reason as UserGroupRefusal] : null;
}

const holds = (me: Me | null, key: string) => holdsPermission(me?.permissions, key);

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
  if (isPlatformTenant(me?.tenant?.type)) return holds(me, USER_SEARCH) ? "platform" : "ids";
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

// ------------------------------------------------------------ the draft (GR-1-j)

/** A member's key in the draft: `user:<id>` or `tenant:<id>`. */
export const memberKey = (m: { memberType: "user" | "tenant"; userId: string | null; tenantId: string | null }) =>
  m.memberType === "user" ? `user:${m.userId}` : `tenant:${m.tenantId}`;

/** Someone picked to join: a person, or a reseller on the platform's own group. */
export type MemberPick = { kind: "user" | "tenant"; id: string; label: string };
/** When a membership ends, as the visitor's wall time `YYYY-MM-DDTHH:mm` (GR-1-k), or null for never. */
export type WallTime = string;
export type DraftAdd = MemberPick & { endAt: WallTime | null };

/** A saved end (an ISO instant) as the visitor's wall time, minute precise — what the draft compares against. */
export function wallTimeOf(iso: string | null): WallTime | null {
  if (!iso) return null;
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A wall time in the visitor's zone as the instant the server stores. */
export const instantOf = (wall: WallTime) => new Date(`${wall}:00`).toISOString();

/**
 * Every change the members sheet holds until Save (GR-1-j, user 2026-10-10):
 * people to add (each with an end or none), members to remove (by
 * {@link memberKey}), and members whose end moves ({@link memberKey} → wall
 * time, or `null` to clear) — a person's or a reseller's (GR-1-l). An end is a
 * minute, not a day (GR-1-k). Nothing is sent until {@link changesBody}.
 */
export type MembersDraft = { add: DraftAdd[]; remove: string[]; ends: Record<string, string | null> };
export const emptyMembersDraft: MembersDraft = { add: [], remove: [], ends: {} };

const keyOf = (p: MemberPick) => `${p.kind}:${p.id}`;

/**
 * Add `pick`, unless it is pending already or is a member (`present` holds
 * the keys on the page). Someone marked for removal is not added: the removal
 * is cancelled, which is what adding them back means.
 */
export function draftAdd(d: MembersDraft, pick: MemberPick, present: ReadonlySet<string>): MembersDraft {
  const key = keyOf(pick);
  if (d.remove.includes(key)) return { ...d, remove: d.remove.filter((k) => k !== key) };
  if (present.has(key) || d.add.some((a) => keyOf(a) === key)) return d;
  return { ...d, add: [...d.add, { ...pick, endAt: null }] };
}

/** A pending add is dropped; a member is marked for removal, or unmarked; a removed member's end move goes with it. */
export function draftToggleRemove(d: MembersDraft, key: string): MembersDraft {
  if (d.add.some((a) => keyOf(a) === key)) return { ...d, add: d.add.filter((a) => keyOf(a) !== key) };
  if (d.remove.includes(key)) return { ...d, remove: d.remove.filter((k) => k !== key) };
  const ends = { ...d.ends };
  delete ends[key];
  return { ...d, remove: [...d.remove, key], ends };
}

/** An end on a pending add, or on a member — kept only when it differs from the one they have (`was`, {@link wallTimeOf}). */
export function draftEnd(d: MembersDraft, key: string, at: WallTime | null, was: WallTime | null): MembersDraft {
  if (d.add.some((a) => keyOf(a) === key)) return { ...d, add: d.add.map((a) => (keyOf(a) === key ? { ...a, endAt: at } : a)) };
  const ends = { ...d.ends };
  if (at === was) delete ends[key];
  else ends[key] = at;
  return { ...d, ends };
}

/** How many changes Save would make. */
export const draftSize = (d: MembersDraft) => d.add.length + d.remove.length + Object.keys(d.ends).length;

/** The one `POST …/members/changes` body (GR-1-i), each end its instant in the visitor's zone; `null` when there is nothing to save. */
export function changesBody(d: MembersDraft): MemberChangesBody | null {
  if (draftSize(d) === 0) return null;
  const at = (wall: WallTime | null) => (wall ? instantOf(wall) : null);
  return {
    add: d.add.map((a) => (a.kind === "user" ? { userId: a.id, expiresAt: at(a.endAt) } : { tenantId: a.id, expiresAt: at(a.endAt) })),
    remove: d.remove.map((k) => (k.startsWith("user:") ? { userId: k.slice(5) } : { tenantId: k.slice(7) })),
    ends: Object.entries(d.ends).map(([key, wall]) => (key.startsWith("user:") ? { userId: key.slice(5), expiresAt: at(wall) } : { tenantId: key.slice(7), expiresAt: at(wall) })),
  };
}

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
export const isPlatformGroup = (me: Me | null, tenantId: string | null) => isPlatformTenant(me?.tenant?.type) && (tenantId === null || tenantId === me?.tenant.id);

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
 * On the platform's own group (`platformGroup`) a preset's `platformKeys` join
 * its keys (GR-1-s: Support's `platform.support`, ADR-0141); on a reseller's
 * they are neither offered nor named.
 */
export function presetDraft(
  preset: GroupPreset | null,
  areas: readonly PermissionArea[],
  grantable: readonly string[],
  platformGroup = false,
): { keys: string[]; dropped: string[] } {
  if (!preset) return { keys: [], dropped: [] };
  const extra = platformGroup ? (preset.platformKeys ?? []) : [];
  const offered = new Set(areas.flatMap((a) => a.permissions.filter((p) => !p.platformOnly || extra.includes(p.key)).map((p) => p.key)));
  const can = (key: string) => offered.has(key) && holdsPermission(grantable, key);
  if (preset.every) return { keys: [...offered].filter((k) => !NEVER_PRESET(k) && can(k)).sort(), dropped: [] };
  const keys = [...new Set([...preset.keys, ...extra])].sort();
  return { keys: keys.filter(can), dropped: keys.filter((k) => !can(k)) };
}
