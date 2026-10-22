import { RealtimeEvents } from "@/generated/wire";
import { userChannel } from "@/lib/realtime";

/**
 * A config move job as it runs, whichever kind — Grants to another group
 * (F-027-ev) or configs to another panel (F-311-ae): billing's `config_move_job`
 * table, one progress event, one card (`MoveJobCard`).
 */

/** A move job's progress (billing `announceProgress`): a batch moved, the job ended or was stopped. */
export const MOVE_JOB_EVENTS: readonly string[] = [RealtimeEvents.configMoveJobProgress];

/**
 * Where the job's progress reaches its starter: their own `user:` channel,
 * which billing names in the payload. A reseller's admin on the platform's
 * panel is on the platform tenant, so its `tenant:` channel is not theirs to
 * hold (`realtime/contract.channels.md`).
 */
export function moveJobChannel(userId: string | null): string | null {
  return userId ? userChannel(userId) : null;
}

/** The card's sentences: each move kind has its own namespace of this shape. */
export interface MoveJobKeys {
  status: { running: string; done: string; cancelled: string };
  progress: string;
  counts: string;
  cancel: string;
  cancelConfirm: string;
  doneNote: string;
  cancelledNote: string;
  problems: string;
  problemLine: string;
  purged: string;
}
