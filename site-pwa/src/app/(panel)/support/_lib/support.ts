import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { SUPPORT_FILE_TYPES, type ConversationStatus, type ScanStatus, type SupportCounts, type SupportMessage, type SupportRating } from "@/lib/support-api";

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
export function mergeMessages<M extends SupportMessage>(held: readonly M[], incoming: readonly M[]): M[] {
  const bySeq = new Map<number, M>();
  for (const m of held) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** What the thread screen holds that the channel moves. */
export interface ThreadState<M extends SupportMessage = SupportMessage> {
  conversationId: string;
  status: ConversationStatus;
  /** Oldest first. */
  messages: M[];
  /** How far the other side has read — "seen". */
  seenUpToSeq: number;
  /** Epoch ms the other side's typing indicator lasts until; 0 = not typing. */
  peerTypingUntil: number;
}

/** Who is watching the thread: the user who owns it, or an agent of its tenant (F-033-p). */
export type ThreadSide = "user" | "agent";

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
 * Apply one event, as `side` sees it. `reread` asks for `?afterSeq=` from the
 * last held message: the channel is at-most-once, so a message whose `seq`
 * skips one means one was published to nobody. An agent always re-reads on a
 * message — the channel carries the user's view of it, with no `internal`
 * and no sender account (support invariant 5).
 *
 * Typing and "seen" are the other side's: a user watches agents; an agent
 * watches the user, never a colleague.
 */
export function applySupportEvent<M extends SupportMessage>(
  s: ThreadState<M>,
  e: SupportEvent,
  now: number,
  side: ThreadSide = "user",
): { next: ThreadState<M>; reread: boolean } {
  const peer = (kind: string) => (side === "user" ? kind !== "user" : kind === "user");
  switch (e.kind) {
    case "support.message": {
      const fromPeer = peer(e.message.senderKind);
      const typing = fromPeer ? 0 : s.peerTypingUntil;
      if (side === "agent") return { next: { ...s, status: e.status, peerTypingUntil: typing }, reread: true };
      const last = s.messages.at(-1)?.seq ?? 0;
      return {
        next: { ...s, status: e.status, messages: mergeMessages(s.messages, [e.message as M]), peerTypingUntil: typing },
        reread: e.message.seq > last + 1,
      };
    }
    case "support.read":
      return { next: peer(e.readerKind) ? { ...s, seenUpToSeq: Math.max(s.seenUpToSeq, e.lastReadSeq) } : s, reread: false };
    case "support.typing":
      return { next: peer(e.senderKind) ? { ...s, peerTypingUntil: now + e.expiresInMs } : s, reread: false };
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

/** The list's tabs (UX-1-w, `contract.ux.md` T2), in their order on screen. */
export const TICKET_TABS = ["all", "open", "waiting", "resolved", "closed"] as const;
export type TicketTab = (typeof TICKET_TABS)[number];

/** What each tab lists and counts; `all` filters nothing. "Open" is ours to answer, "waiting" is the user's. */
const TAB_STATUSES: Record<TicketTab, readonly ConversationStatus[] | undefined> = {
  all: undefined,
  open: ["open", "pending_agent"],
  waiting: ["pending_user"],
  resolved: ["resolved"],
  closed: ["closed"],
};

export const tabStatuses = (tab: TicketTab) => TAB_STATUSES[tab];

/** `?status=` as a tab; anything else is the first tab, as the kit `Tabs` reads it. */
export const readTicketTab = (v: string | null): TicketTab => (TICKET_TABS as readonly string[]).includes(v ?? "") ? (v as TicketTab) : "all";

export function tabCount(tab: TicketTab, counts: SupportCounts): number {
  const statuses = TAB_STATUSES[tab] ?? (Object.keys(counts) as ConversationStatus[]);
  return statuses.reduce((sum, s) => sum + (counts[s] ?? 0), 0);
}

/** Search starts at support's own floor (`q`: 2–64). */
export const SEARCH_MIN = 2;
export const SEARCH_MAX = 64;

/** Split picked files into what support accepts and the names it would refuse (`file_rejected`). */
export function acceptSupportFiles(files: readonly File[]): { accepted: File[]; refused: string[] } {
  const types: readonly string[] = SUPPORT_FILE_TYPES;
  const accepted = files.filter((f) => types.includes(f.type));
  return { accepted, refused: files.filter((f) => !types.includes(f.type)).map((f) => f.name) };
}

/** One sender's messages this close together share one label (T4). */
export const GROUP_WINDOW_MS = 5 * 60_000;

/** `YYYY-MM-DD` of an instant on the wall clock of `zone` — the viewer's resolved zone (TZ-1-e), else this browser's. */
export function dayKey(iso: string, zone?: string | null): string {
  const date = new Date(iso);
  const parts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  try {
    return new Intl.DateTimeFormat("en-CA", zone ? { ...parts, timeZone: zone } : parts).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", parts).format(date);
  }
}

export type ThreadItem<M extends SupportMessage> = { kind: "day"; day: string; at: string } | { kind: "message"; message: M; first: boolean };

/**
 * The thread as drawn (UX-1-x, `contract.ux.md` T4): a separator before each
 * new day in `zone`, and `first` on a message that opens a group — another
 * sender (`senderOf`), more than 5 minutes after the one before, or a new day.
 */
export function threadItems<M extends SupportMessage>(messages: readonly M[], senderOf: (m: M) => string, zone?: string | null): ThreadItem<M>[] {
  const items: ThreadItem<M>[] = [];
  let prev: M | null = null;
  let prevDay = "";
  for (const m of messages) {
    const day = dayKey(m.createdAt, zone);
    const newDay = day !== prevDay;
    if (newDay) items.push({ kind: "day", day, at: m.createdAt });
    const gap = prev ? Date.parse(m.createdAt) - Date.parse(prev.createdAt) : Infinity;
    const first = newDay || !prev || senderOf(prev) !== senderOf(m) || gap > GROUP_WINDOW_MS;
    items.push({ kind: "message", message: m, first });
    prev = m;
    prevDay = day;
  }
  return items;
}

/** Ctrl/⌘+Enter sends; Enter alone, Shift+Enter and an IME's Enter are a line (user, 2026-10-05). */
export function isSendKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey?: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing;
}

/** Past this far from the bottom, a new message waits behind "go to the latest" instead of scrolling (T4). */
export const AWAY_PX = 200;
export const awayFromBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX;
