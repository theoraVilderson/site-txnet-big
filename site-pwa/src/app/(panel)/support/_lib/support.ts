import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { ConversationStatus, ScanStatus, SupportMessage, SupportRating } from "@/lib/support-api";

/** The page's strings as generated constants (C-06). */
export const SUPPORT_KEYS = FrontendI18nKeys.common.support;
const K = SUPPORT_KEYS;

export const STATUS_KEYS: Record<ConversationStatus, string> = K.status;
export const SCAN_KEYS: Record<ScanStatus, string> = K.scan;

/** Prisma's `MessageSenderKind`; a kind this page does not know yet reads as the team. */
const SENDER_KEYS: Record<string, string> = K.sender;
export const senderKey = (kind: string, mine: boolean): string => (mine ? K.sender.user : (SENDER_KEYS[kind] ?? K.sender.agent));

/**
 * One list, by `seq`. A message arrives twice as a rule — the sender's own
 * answer and the channel's event, or a re-read after a gap overlapping what is
 * held — so the later copy wins: its attachment URLs were minted later.
 */
export function mergeMessages(held: readonly SupportMessage[], incoming: readonly SupportMessage[]): SupportMessage[] {
  const bySeq = new Map<number, SupportMessage>();
  for (const m of held) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** What the thread screen holds that the channel moves. */
export interface ThreadState {
  conversationId: string;
  status: ConversationStatus;
  /** Oldest first. */
  messages: SupportMessage[];
  /** How far the agent has read — "seen". */
  seenUpToSeq: number;
  /** Epoch ms the agent's typing indicator lasts until; 0 = not typing. */
  agentTypingUntil: number;
}

/** The four events on `support:<id>` (support/contract.md "Emits"). */
export type SupportEvent =
  | { kind: "support.message"; status: ConversationStatus; message: SupportMessage }
  | { kind: "support.read"; readerKind: string; lastReadSeq: number }
  | { kind: "support.typing"; senderKind: string; expiresInMs: number }
  | { kind: "support.status"; status: ConversationStatus };

const STATUSES = new Set(Object.keys(STATUS_KEYS));
const isStatus = (v: unknown): v is ConversationStatus => typeof v === "string" && STATUSES.has(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function readMessage(v: unknown): SupportMessage | null {
  const m = v as Partial<SupportMessage> | null;
  if (!m || typeof m !== "object" || typeof m.id !== "string" || !isInt(m.seq)) return null;
  if (typeof m.senderKind !== "string" || typeof m.body !== "string" || typeof m.createdAt !== "string") return null;
  // The channel strips `mine` (one message, every reader); on this side only the owner writes as `user`.
  return { ...(m as SupportMessage), mine: m.senderKind === "user", attachments: Array.isArray(m.attachments) ? m.attachments : [] };
}

/**
 * An event for this conversation, or `null` — another thread's, a shape this
 * page does not know, or one missing a field. A refused event is dropped, not
 * guessed at: the stored thread is the record, and the next read has it.
 */
export function readSupportEvent(payload: unknown, conversationId: string): SupportEvent | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.conversationId !== conversationId) return null;
  switch (p.kind) {
    case "support.message": {
      const message = readMessage(p.message);
      return message && isStatus(p.status) ? { kind: p.kind, status: p.status, message } : null;
    }
    case "support.read":
      return typeof p.readerKind === "string" && isInt(p.lastReadSeq) ? { kind: p.kind, readerKind: p.readerKind, lastReadSeq: p.lastReadSeq } : null;
    case "support.typing":
      return typeof p.senderKind === "string" && isInt(p.expiresInMs) ? { kind: p.kind, senderKind: p.senderKind, expiresInMs: p.expiresInMs } : null;
    case "support.status":
      return isStatus(p.status) ? { kind: p.kind, status: p.status } : null;
    default:
      return null;
  }
}

/**
 * Apply one event. `reread` asks for `?afterSeq=` from the last held message:
 * the channel is at-most-once, so a message whose `seq` skips one means one
 * was published to nobody.
 */
export function applySupportEvent(s: ThreadState, e: SupportEvent, now: number): { next: ThreadState; reread: boolean } {
  switch (e.kind) {
    case "support.message": {
      const last = s.messages.at(-1)?.seq ?? 0;
      return {
        next: {
          ...s,
          status: e.status,
          messages: mergeMessages(s.messages, [e.message]),
          agentTypingUntil: e.message.mine ? s.agentTypingUntil : 0,
        },
        reread: e.message.seq > last + 1,
      };
    }
    case "support.read":
      return { next: e.readerKind === "user" ? s : { ...s, seenUpToSeq: Math.max(s.seenUpToSeq, e.lastReadSeq) }, reread: false };
    case "support.typing":
      return { next: e.senderKind === "user" ? s : { ...s, agentTypingUntil: now + e.expiresInMs }, reread: false };
    case "support.status":
      return { next: { ...s, status: e.status }, reread: false };
  }
}

/** What the thread offers — exactly what support accepts (F-033-b, F-033-k). */
export function threadActions(status: ConversationStatus, rating: SupportRating | null) {
  const finished = status === "resolved" || status === "closed";
  return {
    /** A `resolved` thread reopens by a message; only `closed` refuses one. */
    canWrite: status !== "closed",
    canRate: finished && rating === null,
    /** Support still answers `reopen_expired` past the tenant's days; the page shows its sentence. */
    canReopen: status === "closed",
  };
}

/** Sends "typing" at most once per `intervalMs` — the server holds it ~6s; `reset` after a send of the message. */
export function typingGate(intervalMs: number) {
  let last = -Infinity;
  return {
    shouldSend(now: number): boolean {
      if (now - last < intervalMs) return false;
      last = now;
      return true;
    },
    reset(): void {
      last = -Infinity;
    },
  };
}

/** A file size for a person: whole KB below 1 MB, one decimal above. */
export function fileSize(bytes: number): { key: string; n: string } {
  if (bytes < 1024 * 1024) return { key: K.thread.sizeKb, n: String(Math.max(1, Math.round(bytes / 1024))) };
  return { key: K.thread.sizeMb, n: (bytes / (1024 * 1024)).toFixed(1) };
}
