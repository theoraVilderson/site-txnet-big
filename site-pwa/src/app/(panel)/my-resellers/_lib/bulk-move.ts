import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ConfigActionRefusal, ConfigMoveBody, ConfigMoveJob, ConfigMoveSelection, ConfigMoveSource, MoveTarget } from "@/lib/billing-api";
import { ADMIN_REFUSAL_KEYS } from "./users";

/**
 * «جابه‌جایی گروهی» (F-311-ae -> billing F-311-ad, D-63): every live config on
 * one panel, or of the users ticked, to another panel, as a job. Nothing here
 * decides — billing does, per config — it mirrors billing's body and names
 * each refusal.
 */
export const BULK_MOVE_KEYS = FrontendI18nKeys.common.bulkMove;
const K = BULK_MOVE_KEYS;

/** billing's `CONFIG_MOVE_MAX_USERS`; a larger move is by panel. */
export const BULK_MOVE_MAX_USERS = 500;

/** billing's `reason` on a move job. */
const MAX_REASON = 500;

/** A user ticked once, unticked on a second press; never past billing's 500. */
export function toggleTickedUser(ticked: string[], userId: string): string[] {
  if (ticked.includes(userId)) return ticked.filter((id) => id !== userId);
  return ticked.length >= BULK_MOVE_MAX_USERS ? ticked : [...ticked, userId];
}

/** The panels a move may target: never the one being emptied (billing's `same_panel`). */
export function bulkMoveTargets(targets: MoveTarget[], source: ConfigMoveSource): MoveTarget[] {
  return "panelId" in source ? targets.filter((p) => p.id !== source.panelId) : targets;
}

/** Each user once: billing selects their configs, and a repeat only makes the body longer. */
function normalSource(source: ConfigMoveSource): ConfigMoveSource {
  return "userIds" in source ? { userIds: [...new Set(source.userIds)] } : source;
}

/** A source billing accepts: a panel named, or 1..500 users. */
export function sourceReady(source: ConfigMoveSource): boolean {
  const picked = normalSource(source);
  return "panelId" in picked ? picked.panelId !== "" : picked.userIds.length > 0 && picked.userIds.length <= BULK_MOVE_MAX_USERS;
}

export type BulkMoveForm = { toPanelId: string; reason: string };

export type BulkMoveValidation = { ok: true; body: ConfigMoveBody } | { ok: false; errors: Record<string, string> };

/**
 * Billing's `configMoveJobSchema`: one source, a target other than the source
 * panel, a reason. `requestId` is minted once per opened sheet by the caller,
 * so a double click starts one job.
 */
export function validateBulkMove(form: BulkMoveForm, source: ConfigMoveSource, requestId: string): BulkMoveValidation {
  const errors: Record<string, string> = {};
  const picked = normalSource(source);
  if (!sourceReady(picked)) errors.source = K.invalid.source;
  if (!form.toPanelId || ("panelId" in picked && picked.panelId === form.toPanelId)) errors.toPanelId = K.invalid.toPanelId;
  const reason = form.reason.trim();
  if (reason.length === 0 || reason.length > MAX_REASON) errors.reason = K.invalid.reason;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { requestId, source: picked, toPanelId: form.toPanelId, reason } };
}

/**
 * "Retry the failed": the ended job's own source and target, asked again. The
 * configs it moved are no longer on the source and a moved user's are on the
 * target, so billing selects only what is left — refused, failed, or never
 * reached by a stop. `null` while it runs or when nothing was left.
 */
export function retrySelection(job: ConfigMoveJob): ConfigMoveSelection | null {
  if (job.status === "running" || job.ok >= job.total) return null;
  return { source: job.source, toPanelId: job.toPanelId };
}

type OwnRefusal = keyof typeof K.refusal;

/**
 * A reason billing gives — on a refused config, or on the call itself — as
 * its sentence: the move job's own, then one config action's
 * (`ADMIN_REFUSAL_KEYS`); `null` when it is neither, for the page to name.
 */
export function bulkMoveRefusal(reason: unknown): string | null {
  if (typeof reason !== "string") return null;
  if (reason in K.refusal) return K.refusal[reason as OwnRefusal];
  return reason in ADMIN_REFUSAL_KEYS ? ADMIN_REFUSAL_KEYS[reason as ConfigActionRefusal] : null;
}

/** A refused config's sentence; a reason nobody has written one for yet reads as `failed`, never blank. */
export function bulkMoveOutcomeKey(reason: string): string {
  return bulkMoveRefusal(reason) ?? K.refusal.failed;
}
