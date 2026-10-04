// Support (F-033-o), served by `support-service` on `/api/support` on the
// page's own domain, behind `forward-auth` (ADR-0112). No route names a user:
// the gate's `X-User-Id` decides whose threads they are, and another user's
// thread answers exactly as a missing one (support invariant 6).
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: `${API_BASE}/support`,
  service: "support-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  credentialSettled: () => authApi.credentialSettled(),
});

/** Prisma's `ConversationStatus`. */
export type ConversationStatus = "open" | "pending_user" | "pending_agent" | "resolved" | "closed";
/** Prisma's `AttachmentScanStatus`; only `clean` carries a URL (ADR-0113). */
export type ScanStatus = "pending" | "clean" | "infected" | "failed";

export interface SupportRating {
  score: number;
  comment: string | null;
  ratedAt: string;
}

/** `ConversationSummary`, dates as ISO strings. */
export interface SupportConversation {
  id: string;
  subject: string;
  categoryId: string | null;
  status: ConversationStatus;
  mode: "live" | "async";
  priority: string;
  lastSeq: number;
  lastMessageAt: string;
  createdAt: string;
  unread: number;
  rating: SupportRating | null;
}

/** `AttachmentView`. `url` is a path on this Host, valid five minutes from the read. */
export interface SupportAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: ScanStatus;
  url: string | null;
  urlExpiresAt: string | null;
  /** Retention deleted the file (F-033-n). */
  expired: boolean;
}

/** `MessageView`. An agent is a kind, never an account. */
export interface SupportMessage {
  id: string;
  seq: number;
  senderKind: string;
  mine: boolean;
  body: string;
  createdAt: string;
  attachments: SupportAttachment[];
}

export interface SupportChannel {
  channel: string;
  proof: string;
  expiresInSec: number;
}

/** `MessagePage`: oldest first, the reader's cursor and the agent's ("seen"). */
export interface SupportMessagePage {
  conversation: SupportConversation;
  messages: SupportMessage[];
  hasEarlier: boolean;
  lastReadSeq: number;
  seenUpToSeq: number;
  /** `null` when the socket is unavailable — the thread still reads. */
  realtime: SupportChannel | null;
}

export interface SupportCategory {
  id: string;
  key: string;
  name: string;
}

/** The wait notice (F-033-g). */
export interface SupportAvailability {
  live: boolean;
  withinHours: boolean;
  agentsOnline: boolean;
  nextOpenAt: string | null;
}

/** The file types support accepts (catalog §11.4); anything else is `file_rejected`. */
export const SUPPORT_FILE_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"] as const;
export const SUPPORT_BODY_MAX = 4000;

const post = (body?: unknown): RequestInit => ({ method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return q ? `?${q}` : "";
}

const thread = (id: string) => `/conversations/${encodeURIComponent(id)}`;

export const supportApi = {
  categories(): Promise<SupportCategory[]> {
    return call<SupportCategory[]>("/categories", { method: "GET" });
  },
  availability(): Promise<SupportAvailability> {
    return call<SupportAvailability>("/availability", { method: "GET" });
  },
  /** Newest activity first; `nextBefore` pages further back. */
  list(before?: string): Promise<{ items: SupportConversation[]; nextBefore: string | null }> {
    return call(`/conversations${query({ before, limit: 30 })}`, { method: "GET" });
  },
  open(body: { body: string; subject?: string; categoryId?: string }): Promise<SupportConversation> {
    return call<SupportConversation>("/conversations", post(body));
  },
  /** Neither cursor = the latest page; `afterSeq` after a gap, `beforeSeq` for earlier. */
  messages(id: string, at: { afterSeq?: number; beforeSeq?: number } = {}): Promise<SupportMessagePage> {
    return call<SupportMessagePage>(`${thread(id)}/messages${query({ ...at, limit: 50 })}`, { method: "GET" });
  },
  send(id: string, body: string): Promise<SupportMessage> {
    return call<SupportMessage>(`${thread(id)}/messages`, post({ body }));
  },
  /** One message carrying the files, and `body` if any. */
  attach(id: string, files: File[], body?: string): Promise<SupportMessage> {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    if (body) form.append("body", body);
    return call<SupportMessage>(`${thread(id)}/attachments`, { method: "POST", body: form });
  },
  typing(id: string): Promise<{ expiresInMs: number }> {
    return call(`${thread(id)}/typing`, post());
  },
  read(id: string, upToSeq: number): Promise<{ lastReadSeq: number }> {
    return call(`${thread(id)}/read`, post({ upToSeq }));
  },
  rate(id: string, score: number, comment?: string): Promise<SupportRating> {
    return call<SupportRating>(`${thread(id)}/rating`, post({ score, ...(comment ? { comment } : {}) }));
  },
  reopen(id: string): Promise<{ id: string; status: ConversationStatus }> {
    return call(`${thread(id)}/reopen`, post());
  },
};
