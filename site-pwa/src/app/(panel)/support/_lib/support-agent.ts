import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { AgentConversation, ConversationStatus, InboxView, SlaTarget, SupportPriority, SupportSla } from "@/lib/support-api";

/** The agent's and admin's strings as generated constants (C-06). */
export const AGENT_KEYS = FrontendI18nKeys.common.supportAgent;
const K = AGENT_KEYS;

export const PRIORITY_KEYS: Record<SupportPriority, string> = K.priority;
export const VIEW_KEYS: Record<InboxView, string> = K.views;
/** Urgent first: the queue's own order (support/contract.md "SLA"). */
export const PRIORITIES: readonly SupportPriority[] = ["urgent", "high", "normal", "low"];
export const INBOX_VIEWS: readonly InboxView[] = ["pending", "live", "mine", "unassigned"];

/** The presence heartbeat (F-033-g): support forgets an agent 90s after the last beat. */
export const PRESENCE_EVERY_MS = 30_000;
/** How close a running clock has to be to show "due soon". */
const DUE_SOON_MS = 30 * 60_000;
/** support's `SLA_MINUTES_MAX`: thirty days of minutes. */
export const SLA_MINUTES_MAX = 43_200;

export type SlaState = "breached" | "soon" | "running" | "stopped";

/**
 * The inbox badge. Breached is support's verdict, or a running clock already
 * past due (the list was read a while ago); a stopped clock — waiting on the
 * user, or settled — is never "due".
 */
export function slaState(sla: SupportSla, now: number): SlaState {
  if (sla.firstResponseBreached || sla.resolutionBreached) return "breached";
  if (!sla.dueAt) return "stopped";
  const left = Date.parse(sla.dueAt) - now;
  if (left <= 0) return "breached";
  return left <= DUE_SOON_MS ? "soon" : "running";
}

/** What the agent is offered — exactly what support accepts (F-033-d). A closed thread is read-only. */
export function agentActions(c: Pick<AgentConversation, "status" | "assignedToUserId">, me: string) {
  const closed = c.status === "closed";
  const finished = closed || c.status === "resolved";
  return {
    canTake: !closed && c.assignedToUserId !== me,
    canRelease: !closed && c.assignedToUserId === me,
    canResolve: !finished,
    canClose: !closed,
    canWrite: !closed,
    canPrioritize: !closed,
  };
}

/** Minutes of the day as support's `HH:MM`; 1440 is "24:00", the end of a day. */
export function toHhmm(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** `HH:MM` as minutes, `24:00` included; `null` for anything support would refuse. */
export function fromHhmm(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && minutes <= 1440 ? minutes : null;
}

/** The priorities whose targets support would refuse: `0 < first ≤ resolution ≤ 43200`. */
export function slaFormErrors(targets: readonly SlaTarget[]): SupportPriority[] {
  const ok = (n: number) => Number.isInteger(n) && n > 0 && n <= SLA_MINUTES_MAX;
  return targets
    .filter((t) => !(ok(t.firstResponseMinutes) && ok(t.resolutionMinutes) && t.firstResponseMinutes <= t.resolutionMinutes))
    .map((t) => t.priority);
}

/** A category's names as support takes them: trimmed, a language left empty dropped. */
export function categoryTexts(names: Record<string, string>): { lang: string; name: string }[] {
  return Object.entries(names)
    .map(([lang, name]) => ({ lang, name: name.trim() }))
    .filter((t) => t.name.length > 0);
}

/** An unfinished status: the threads the inbox's views other than `pending` list. */
export const isUnfinished = (s: ConversationStatus) => s === "open" || s === "pending_user" || s === "pending_agent";
