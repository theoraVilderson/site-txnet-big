import { holdsPermission } from "@/lib/permissions";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { PersonGroup, ResellerUser } from "@/lib/auth-api";
import type { AdminConfigAction, AdminConfigActionBody, ConfigActionRefusal, UsersCatalogProduct } from "@/lib/billing-api";
import { PANEL_GROUPS, myResellerGroupsPath, myResellerUserPath, panelUserPath, resellerWorkspaceRoot } from "@/lib/routes";
import { REFUSAL_KEYS } from "../../services/_lib/service-configs";
import { isPlatformTenant, type TenantType } from "@/lib/tenant-type";

/** The screens' strings as generated constants (C-06). */
export const USER_KEYS = FrontendI18nKeys.common.resellerUsers;
const K = USER_KEYS;

/**
 * Every reason either door refuses with: shared-core's `ResellerAccessRejection`
 * (who may administer this reseller, invariant 21), auth's user fence
 * (F-311-a) and billing's (F-311-f), and the door's consent refusals
 * (`SupportConsentRefused`, F-117-b). The spec reads the union from both
 * controllers' exhaustive `STATUS` maps, so a reason added there has no
 * sentence here until one is written.
 */
export type UserRefusal =
  | "not_allowed"
  | "reseller_not_found"
  | "reseller_suspended"
  | "reseller_terminated"
  | "user_not_found"
  | "user_banned"
  | "cannot_block_self"
  | "no_authority"
  | "consent_required"
  | "consent_read_only"
  | "username_taken";

export const USER_REFUSAL_KEYS: Record<UserRefusal, string> = K.refusals;

/** The refusal's own sentence key, when a door named one these screens know. */
export function userRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in USER_REFUSAL_KEYS ? USER_REFUSAL_KEYS[reason as UserRefusal] : null;
}

/**
 * The Profile tab's body (AC-1-a): only the fields that changed, trimmed, or
 * `null` when nothing did — the route refuses `{}`. An emptied username is
 * no edit: the route has none that clears it.
 */
export function profileChanges(
  current: { fullName: string; username: string | null },
  form: { fullName: string; username: string },
): { fullName?: string; username?: string } | null {
  const edit: { fullName?: string; username?: string } = {};
  const fullName = form.fullName.trim();
  const username = form.username.trim();
  if (fullName && fullName !== current.fullName) edit.fullName = fullName;
  if (username && username !== (current.username ?? "")) edit.username = username;
  return Object.keys(edit).length > 0 ? edit : null;
}

/**
 * The Profile tab's groups (GR-1-u, ADR-0139 (1)): the ones the person is in,
 * and the ones this caller may add them to. A group whose keys the caller does
 * not all hold is never offered — the server would refuse `key_not_held`.
 */
export function personGroupLists(groups: readonly PersonGroup[]): { member: PersonGroup[]; joinable: PersonGroup[] } {
  return { member: groups.filter((g) => g.member), joinable: groups.filter((g) => !g.member && g.mayChange) };
}

/**
 * The Groups page that holds this person's groups — the session's own (`tenantId`
 * null) or the path's tenant's — where the Profile tab sends a caller with no
 * group left to add them to (user, 2026-10-14).
 */
export function groupsPagePath(tenantId: string | null, self: boolean): string {
  return tenantId === null ? PANEL_GROUPS : myResellerGroupsPath(tenantId, self);
}

/** `GET /auth/tenants/:id/users` takes `q` of 3-64 characters (F-311-a). */
export const USERS_QUERY_MIN = 3;
const USERS_QUERY_MAX = 64;
export const USERS_PAGE_SIZE = 20;

/**
 * The list's query: a search shorter than the route takes is no search, not a
 * 400 — two typed letters keep the unfiltered list up until the third.
 */
export function usersQuery(raw: string, page: number): { q?: string; page: number } {
  const q = raw.trim().slice(0, USERS_QUERY_MAX);
  return q.length >= USERS_QUERY_MIN ? { q, page } : { page };
}

/**
 * What the list offers a user of this status (F-311-v4): block an active
 * one, unblock a blocked one, and nothing for a platform ban — a reseller
 * neither deepens nor lifts it (`user_banned`).
 */
/** One act on a person's status from the users list (ADR-0133, BAN-1-h). */
export type StatusAction = "restrict" | "lift" | "ban" | "unban";

/**
 * What the list offers a person: restrict or lift (the reseller block, open to
 * anyone the page admits), and the ban and its lift only where `canBan`.
 */
export function statusActionsOf(status: ResellerUser["status"], canBan: boolean): StatusAction[] {
  if (status === "banned") return canBan ? ["unban"] : [];
  const first: StatusAction = status === "active" ? "restrict" : "lift";
  return canBan ? [first, "ban"] : [first];
}

/**
 * A ban goes through `PUT /auth/users/:id/status`, which acts in the caller's
 * own tenant only — so only on the session's own users page, and only with
 * `user.ban`.
 */
export function canBanHere(
  id: string,
  me: { tenant: { id: string }; permissions: readonly string[] } | null,
): boolean {
  return !!me && me.tenant.id === id && holdsPermission(me.permissions, "user.ban");
}

/**
 * The config actions the sheet offers (F-311-g): billing's
 * `ADMIN_CONFIG_ACTIONS`, `move` among them — its targets are F-311-v1's read.
 */
export const ADMIN_ACTIONS = ["regenerate", "disable", "enable", "retire", "move"] as const satisfies readonly AdminConfigAction[];
export type OfferedAction = (typeof ADMIN_ACTIONS)[number];

/** `adminConfigActionSchema`'s bounds: 1..50 ids, a disable's reason 1..200 after a trim. */
const MAX_CONFIGS = 50;
const MAX_REASON = 200;

/**
 * The body, exactly, or `null` where the schema would refuse it: a `reason`
 * with a disable and a `toPanelId` with a move, each with nothing else, 1..50
 * ids. The schema refuses the whole request — every config — for a body it
 * cannot read, so the sheet never sends one.
 */
export function adminActionBody(action: OfferedAction, configIds: string[], reason?: string, toPanelId?: string): AdminConfigActionBody | null {
  if (configIds.length === 0 || configIds.length > MAX_CONFIGS) return null;
  if (action === "move") return toPanelId ? { action, configIds, toPanelId } : null;
  if (action !== "disable") return { action, configIds };
  const why = (reason ?? "").trim();
  if (why.length === 0 || why.length > MAX_REASON) return null;
  return { action, configIds, reason: why };
}

/** One config's refusal on the admin sheet: the owner's sentences, with a move's own two. */
export const ADMIN_REFUSAL_KEYS: Record<ConfigActionRefusal, string> = {
  ...REFUSAL_KEYS,
  same_panel: K.actions.refusal.same_panel,
  panel_not_found: K.actions.refusal.panel_not_found,
};

/**
 * Whether the path's tenant is the platform's own (F-311-ab): the session's,
 * signed in to the platform (F-311-aa). The platform has no console to go
 * back to, and its page is titled as the menu entry that opened it.
 */
/**
 * Where one user's page is: `/users/:userId` when the list is the session's
 * own users (`own`), the reseller workspace's address otherwise.
 */
export function userPagePath(id: string, userId: string, own: boolean, self: boolean): string {
  return own ? panelUserPath(userId) : myResellerUserPath(id, userId, self);
}

/**
 * The `/users`, `/team` or `/roles` address of a `/my-resellers/<session
 * tenant>/…` one — the session's own people pages before they had their own
 * (2026-10-09) — or `null` for any other path, a real reseller's included.
 */
export function ownTenantRedirect(pathname: string, sessionTenantId: string | null | undefined): string | null {
  if (!sessionTenantId) return null;
  const root = resellerWorkspaceRoot(sessionTenantId);
  const rest = pathname.startsWith(`${root}/`) ? pathname.slice(root.length) : "";
  return /^\/(users|team|roles)(\/|$)/.test(rest) ? rest : null;
}

/** Is the workspace `id` the platform's own tenant, as the caller sees it? */
export function isPlatformWorkspace(
  id: string,
  me: { tenant: { id: string; type: TenantType } } | null,
): boolean {
  return me != null && isPlatformTenant(me.tenant.type) && me.tenant.id === id;
}

/**
 * What the issue form offers (F-311-ab2): active plans of active products. The
 * bulk filter takes the whole list — a service sold before a switch-off is
 * still filtered by. Billing refuses what it cannot place either way.
 */
export function issuableProducts(products: readonly UsersCatalogProduct[]): UsersCatalogProduct[] {
  return products
    .filter((p) => p.isActive)
    .map((p) => ({ ...p, variants: p.variants.filter((v) => v.isActive) }))
    .filter((p) => p.variants.length > 0);
}
