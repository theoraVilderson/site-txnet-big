import { GRANT_REFUSAL_KEYS, grantActionBody, type GrantAction, type GrantActionDraft } from "./grant-actions";
import { USER_KEYS } from "./users";

/** The strings of the users page's search, its bulk acts and a Grant's history (C-06). */
export const FIND_KEYS = USER_KEYS.find;
export const BULK_KEYS = USER_KEYS.bulk;
export const HISTORY_KEYS = USER_KEYS.history;
export const JOB_KEYS = USER_KEYS.bulkJob;

/**
 * The acts billing takes on many Grants at once (F-311-u,
 * `billing/contract.reseller-grants-bulk.md`), by their single-Grant names so
 * the sheet's own fields and sentences serve both. Not delete (a refund answer
 * per Grant), renew or issue (a `requestId` per Grant), nor the link (every
 * user's app would lose it at once).
 */
export const BULK_ACTIONS = ["freeze", "unfreeze", "days", "traffic", "reset", "gift", "speed", "devices"] as const satisfies readonly GrantAction[];
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** The bulk schema's `action` for each: the two traffic acts are named as their routes are. */
export const BULK_ACTION_NAMES: Record<BulkAction, string> = {
  freeze: "freeze",
  unfreeze: "unfreeze",
  days: "days",
  traffic: "traffic",
  reset: "traffic_reset",
  gift: "traffic_gift",
  speed: "speed",
  devices: "devices",
};

/** `grantBulkSchema`'s 1..50 ids a call. */
export const BULK_MAX_GRANTS = 50;

/** A tick on a found service: a second one unticks, and a 51st is not taken. */
export function toggleTicked(ticked: string[], grantId: string): string[] {
  if (ticked.includes(grantId)) return ticked.filter((id) => id !== grantId);
  return ticked.length >= BULK_MAX_GRANTS ? ticked : [...ticked, grantId];
}

/**
 * The bulk body, exactly, or `null` where `grantBulkSchema` would refuse it —
 * and it refuses the whole request, every Grant in it. The action's own
 * fields are the single act's (`grantActionBody`), the reason is required for
 * every action, and the `requestId` is the draft's, minted once per opened
 * form: a double click answers the first call's outcomes (F-311-u1).
 */
export function bulkBody(action: BulkAction, grantIds: string[], d: GrantActionDraft, now: Date = new Date()): (Record<string, unknown> & { grantIds: string[] }) | null {
  const unique = [...new Set(grantIds)];
  if (unique.length === 0 || unique.length > BULK_MAX_GRANTS) return null;
  const own = grantActionBody(action, d, now);
  if (own === null || typeof own.reason !== "string") return null;
  return { requestId: d.requestId, action: BULK_ACTION_NAMES[action], grantIds: unique, ...own };
}

/**
 * What a bulk by filter picks (F-311-x1): every active service, one panel,
 * one product or one variant of it. A variant keeps its product so the picker
 * can show both.
 */
export type BulkScope =
  | { kind: "all" }
  | { kind: "panel"; panelId: string }
  | { kind: "product"; productId: string }
  | { kind: "variant"; productId: string; variantId: string };

/** billing's `grantBulkFilterSchema`, exactly. */
export interface BulkFilter {
  panelId?: string;
  productId?: string;
  variantId?: string;
  statuses: ("active" | "suspended")[];
}

/**
 * The job's filter. The statuses are the act's: an unfreeze reaches the
 * frozen (`suspended`) Grants, every other act the `active` ones — the rest
 * would only be refused, one by one, as outcomes.
 */
export function filterOf(scope: BulkScope, action: BulkAction): BulkFilter {
  const statuses: BulkFilter["statuses"] = [action === "unfreeze" ? "suspended" : "active"];
  switch (scope.kind) {
    case "panel":
      return { panelId: scope.panelId, statuses };
    case "product":
      return { productId: scope.productId, statuses };
    case "variant":
      return { variantId: scope.variantId, statuses };
    default:
      return { statuses };
  }
}

/**
 * A job's start body: the bulk body with `filter` where its `grantIds` were
 * (`grantBulkJobSchema`), or `null` while the pick or a field is missing. One
 * `requestId` per opened form: a double click answers the same job.
 */
export function bulkJobBody(action: BulkAction, filter: BulkFilter | null, d: GrantActionDraft, now: Date = new Date()): Record<string, unknown> | null {
  if (filter === null) return null;
  const own = grantActionBody(action, d, now);
  if (own === null || typeof own.reason !== "string") return null;
  return { requestId: d.requestId, action: BULK_ACTION_NAMES[action], filter, ...own };
}

/** The job routes' own refusals (the controller's `STATUS`); the door's are `USER_REFUSAL_KEYS`. */
export type JobRefusal = keyof typeof JOB_KEYS.refusal;
export const JOB_REFUSAL_KEYS: Record<JobRefusal, string> = JOB_KEYS.refusal;

export function jobRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in JOB_REFUSAL_KEYS ? JOB_REFUSAL_KEYS[reason as JobRefusal] : null;
}

/** How far a job is, over the total frozen at its confirm. */
export function jobPercent(job: { total: number; processed: number }): number {
  return job.total === 0 ? 100 : Math.floor((job.processed / job.total) * 100);
}

/**
 * How often the jobs are read again while one runs. Every read spends the
 * reseller reads' bucket (300 per 15 minutes, per caller), shared with the
 * rest of these pages: 10s is 90 of it for a job watched a quarter hour.
 */
export const JOB_POLL_MS = 10_000;

/**
 * A refused Grant's sentence: the single act's (`GRANT_REFUSAL_KEYS`), the
 * bulk's own `grant_not_found` and `failed`, and `failed`'s for a reason
 * nobody has written one for yet.
 */
export function bulkRefusalKey(reason: string): string {
  if (reason in GRANT_REFUSAL_KEYS) return GRANT_REFUSAL_KEYS[reason as keyof typeof GRANT_REFUSAL_KEYS];
  if (reason === "grant_not_found") return BULK_KEYS.refusal.grant_not_found;
  return BULK_KEYS.refusal.failed;
}

/** Every act a Grant's history holds (`grant-audit.ts`: `GrantAuditAction`, `ConfigAuditAction`). */
export const HISTORY_ACTION_KEYS: Record<keyof typeof HISTORY_KEYS.action, string> = HISTORY_KEYS.action;

/** A history row's label; an act added to the audit later reads as a plain admin act, not a blank. */
export function historyActionKey(action: string): string {
  return action in HISTORY_ACTION_KEYS ? HISTORY_ACTION_KEYS[action as keyof typeof HISTORY_ACTION_KEYS] : HISTORY_KEYS.other;
}
