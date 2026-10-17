import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { RealtimeEvents } from "@/generated/wire";
import type { GroupMoveBody, GroupMoveSource, GroupMoveTarget } from "@/lib/billing-api";
import { userChannel } from "@/lib/realtime";

/**
 * "Move to another group" (F-027-ev -> billing F-027-et, ADR-0127 decision 5):
 * Grants to another panel group, as a job. Nothing here decides — billing
 * does, per Grant — it mirrors billing's body and names each refusal.
 */
export const GROUP_MOVE_KEYS = FrontendI18nKeys.common.groupMove;
const K = GROUP_MOVE_KEYS;

/** billing's `GRANT_GROUP_MOVE_MAX_GRANTS`; a whole group is named by its id instead. */
export const GROUP_MOVE_MAX_GRANTS = 500;

/** billing's `reason` on a move. */
const MAX_REASON = 500;

/** A move job's progress (billing `announceProgress`): a batch moved, the job ended or was stopped. */
export const GROUP_MOVE_EVENTS: readonly string[] = [RealtimeEvents.configMoveJobProgress];

/**
 * Where the job's progress reaches its reader: the starter's own `user:`
 * channel, which billing names in the payload. A reseller's admin on the
 * platform's panel is on the platform tenant, so its `tenant:` channel is not
 * theirs to hold (`realtime/contract.channels.md`).
 */
export function groupMoveChannel(userId: string | null): string | null {
  return userId ? userChannel(userId) : null;
}

/** The groups a move may target: never the one being emptied (billing's `same_group` for each of its Grants). */
export function groupMoveTargets(groups: GroupMoveTarget[], source: GroupMoveSource): GroupMoveTarget[] {
  return "fromGroupId" in source ? groups.filter((g) => g.id !== source.fromGroupId) : groups;
}

/** Each Grant ticked once: billing refuses a repeat, and the whole request with it. */
export function normalSource(source: GroupMoveSource): GroupMoveSource {
  return "grantIds" in source ? { grantIds: [...new Set(source.grantIds)] } : source;
}

export type GroupMoveForm = { toGroupId: string; reason: string };

export type GroupMoveValidation = { ok: true; body: GroupMoveBody } | { ok: false; errors: Record<string, string> };

/**
 * Billing's `grantGroupMoveJobSchema`: one source, a target, a reason.
 * `requestId` is minted once per opened sheet by the caller, so a double click
 * starts one job.
 */
export function validateGroupMove(form: GroupMoveForm, source: GroupMoveSource, requestId: string): GroupMoveValidation {
  const errors: Record<string, string> = {};
  const picked = normalSource(source);
  if ("grantIds" in picked && (picked.grantIds.length === 0 || picked.grantIds.length > GROUP_MOVE_MAX_GRANTS)) errors.source = K.invalid.source;
  if (!form.toGroupId || ("fromGroupId" in picked && picked.fromGroupId === form.toGroupId)) errors.toGroupId = K.invalid.toGroupId;
  const reason = form.reason.trim();
  if (reason.length === 0 || reason.length > MAX_REASON) errors.reason = K.invalid.reason;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: { requestId, source: picked, toGroupId: form.toGroupId, reason } };
}

type Refusal = keyof typeof K.refusal;

/** A reason billing gives — on a refused Grant, or on the call itself — as its sentence, or `null` when it is not a move's. */
export function groupMoveRefusal(reason: unknown): string | null {
  return typeof reason === "string" && reason in K.refusal ? K.refusal[reason as Refusal] : null;
}

/** A refused Grant's sentence; a reason nobody has written one for yet reads as `failed`, never blank. */
export function groupMoveRefusalKey(reason: string): string {
  return groupMoveRefusal(reason) ?? K.refusal.failed;
}
