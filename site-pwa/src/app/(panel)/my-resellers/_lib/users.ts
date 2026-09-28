import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ResellerUser } from "@/lib/auth-api";
import type { AdminConfigAction, AdminConfigActionBody, ConfigActionRefusal } from "@/lib/billing-api";
import { REFUSAL_KEYS } from "../../services/_lib/service-configs";

/** The screens' strings as generated constants (C-06). */
export const USER_KEYS = FrontendI18nKeys.common.resellerUsers;
const K = USER_KEYS;

/**
 * Every reason either door refuses with: shared-core's `ResellerAccessRejection`
 * (who may administer this reseller, invariant 21), auth's user fence
 * (F-311-a) and billing's (F-311-f). The spec reads the union from both
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
  | "cannot_block_self";

export const USER_REFUSAL_KEYS: Record<UserRefusal, string> = K.refusals;

/** The refusal's own sentence key, when a door named one these screens know. */
export function userRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in USER_REFUSAL_KEYS ? USER_REFUSAL_KEYS[reason as UserRefusal] : null;
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
export function blockActionOf(status: ResellerUser["status"]): "block" | "unblock" | null {
  if (status === "active") return "block";
  if (status === "suspended") return "unblock";
  return null;
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

/** The two refusals only a move meets; the owner's list says "failed" for both, since a user never moves. */
export const MOVE_REFUSALS = ["same_panel", "panel_not_found"] as const satisfies readonly ConfigActionRefusal[];

/** One config's refusal on the admin sheet: the owner's sentences, with a move's own two. */
export const ADMIN_REFUSAL_KEYS: Record<ConfigActionRefusal, string> = {
  ...REFUSAL_KEYS,
  same_panel: K.actions.refusal.same_panel,
  panel_not_found: K.actions.refusal.panel_not_found,
};
