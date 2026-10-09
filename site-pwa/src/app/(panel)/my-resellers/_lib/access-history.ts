import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AccessAct } from "@/lib/auth-api";

/** The access history's strings as generated constants (C-06). */
export const ACCESS_HISTORY_KEYS = FrontendI18nKeys.common.accessHistory;
export const ACCESS_ACT_KEYS = ACCESS_HISTORY_KEYS.acts;

type Act = Pick<AccessAct, "action" | "target" | "before" | "after">;
type Sentence = { key: string; params: Record<string, string> };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const keysOf = (v: Record<string, unknown> | null): string[] =>
  Array.isArray(v?.keys) ? (v.keys as unknown[]).filter((k): k is string => typeof k === "string") : [];

/**
 * One act as one sentence, the same in a person's history and the tenant's
 * log (AC-1-p): what happened, to which person, group or role. Names come from
 * the server; a target with none reads as "—". `end` is the seat's end as an
 * ISO instant, empty when it has none — the view formats it.
 */
export function actSentence(act: Act): Sentence {
  const target = act.target.name ?? "—";
  const after = act.after ?? {};
  const before = act.before ?? {};
  switch (act.action) {
    case "role_change":
      return { key: ACCESS_ACT_KEYS.role_change, params: { target, from: str(before.roleName) || "—", to: str(after.roleName) || "—" } };
    case "user_permission_set":
      return {
        key: after.effect === "take" ? ACCESS_ACT_KEYS.user_permission_set_take : ACCESS_ACT_KEYS.user_permission_set_give,
        params: { target, key: str(after.key) },
      };
    case "user_permission_lift":
      return { key: ACCESS_ACT_KEYS.user_permission_lift, params: { target, key: str(before.key) } };
    case "user_group_access_set":
    case "user_group_member_add":
    case "user_group_member_remove":
    case "user_group_delete":
    case "role_keys_set":
    case "staff_seat_invite":
    case "staff_seat_remove":
      return { key: ACCESS_ACT_KEYS[act.action], params: { target } };
    case "staff_seat_end_set":
      return { key: ACCESS_ACT_KEYS.staff_seat_end_set, params: { target, end: str(after.accessExpiresAt) } };
    default:
      return { key: ACCESS_ACT_KEYS.unknown, params: {} };
  }
}

/**
 * What a role's or a group's edit gave and took, from its own before and
 * after — the tenant's log has no person's row to carry it. Every other act
 * moves nothing by itself here: a person's row says what it moved for them.
 */
export function actKeysMoved(act: Act): { given: string[]; taken: string[] } {
  if (act.action !== "role_keys_set" && act.action !== "user_group_access_set") return { given: [], taken: [] };
  const was = new Set(keysOf(act.before));
  const now = new Set(keysOf(act.after));
  return { given: [...now].filter((k) => !was.has(k)).sort(), taken: [...was].filter((k) => !now.has(k)).sort() };
}
