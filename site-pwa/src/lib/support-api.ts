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

// ------------------------------------------------- the agent's side (F-033-p)

/** Prisma's `ConversationPriority`: queue position and SLA targets, never shown to the user. */
export type SupportPriority = "low" | "normal" | "high" | "urgent";
/** support-service's `INBOX_VIEWS`. */
export type InboxView = "pending" | "live" | "mine" | "unassigned";

/** `SlaView` (F-033-h): due times, the clock running now, and whether either target was missed. */
export interface SupportSla {
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  /** `null` while stopped — waiting on the user, or settled. */
  dueAt: string | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
}

/** `AgentConversationView`: the agent side names accounts; the user side never does. */
export interface AgentConversation extends Omit<SupportConversation, "priority"> {
  priority: SupportPriority;
  userId: string;
  assignedToUserId: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  closedAutomatically: boolean;
  sla: SupportSla;
}

/** `AgentMessageView`: notes included, each message naming its sender's account. */
export interface AgentMessage extends SupportMessage {
  internal: boolean;
  senderUserId: string | null;
}

export interface AgentMessagePage extends Omit<SupportMessagePage, "conversation" | "messages"> {
  conversation: AgentConversation;
  messages: AgentMessage[];
}

/** billing's `SupportUserFacts`, passed through as billing shaped it (F-033-m). Money as decimal strings. */
export interface SupportUserFacts {
  wallet: { balance: string; held: string; currencyCode: string } | null;
  grants: {
    items: Array<{
      id: string;
      label: string | null;
      nameKey: string | null;
      status: string;
      frozen: boolean;
      endsAt: string | null;
      consumedBytes: string;
      purchasedBytes: string;
      trafficCapBytes: string | null;
      trafficUnlimited: boolean;
    }>;
    hidden: number;
  };
  invoices: Array<{ id: string; total: string; currencyCode: string; status: string; createdAt: string }>;
  lastConnectionAt: string | null;
}

export interface CannedPick {
  id: string;
  key: string;
  /** In the agent's language: the picker's label. */
  body: string;
  source: "tenant" | "platform";
}

const agentThread = (id: string) => `/agent/conversations/${encodeURIComponent(id)}`;

export const supportAgentApi = {
  /** Urgent first, then the nearest SLA due, then the longest waiting. */
  inbox(view: InboxView, after?: string): Promise<{ items: AgentConversation[]; nextAfter: string | null }> {
    return call(`/agent/conversations${query({ view, after, limit: 50 })}`, { method: "GET" });
  },
  messages(id: string, at: { afterSeq?: number; beforeSeq?: number } = {}): Promise<AgentMessagePage> {
    return call<AgentMessagePage>(`${agentThread(id)}/messages${query({ ...at, limit: 50 })}`, { method: "GET" });
  },
  /** The sidebar; `billing` is `null` when billing did not answer — never an error. */
  context(id: string): Promise<{ userId: string; billing: SupportUserFacts | null }> {
    return call(`${agentThread(id)}/context`, { method: "GET" });
  },
  /** A reply claims an unassigned thread for the replier; a note (`internal`) changes nothing the user sees. */
  reply(id: string, body: string, internal: boolean): Promise<AgentMessage> {
    return call<AgentMessage>(`${agentThread(id)}/messages`, post({ body, internal }));
  },
  assign(id: string, assigneeUserId: string | null): Promise<AgentConversation> {
    return call<AgentConversation>(`${agentThread(id)}/assign`, post({ assigneeUserId }));
  },
  priority(id: string, priority: SupportPriority): Promise<AgentConversation> {
    return call<AgentConversation>(`${agentThread(id)}/priority`, post({ priority }));
  },
  resolve(id: string): Promise<AgentConversation> {
    return call<AgentConversation>(`${agentThread(id)}/resolve`, post());
  },
  close(id: string): Promise<AgentConversation> {
    return call<AgentConversation>(`${agentThread(id)}/close`, post());
  },
  read(id: string, upToSeq: number): Promise<{ lastReadSeq: number }> {
    return call(`${agentThread(id)}/read`, post({ upToSeq }));
  },
  typing(id: string): Promise<{ expiresInMs: number }> {
    return call(`${agentThread(id)}/typing`, post());
  },
  /** The heartbeat (F-033-g): every 30s while the inbox is open; forgotten 90s after the last. */
  presence(status: "online" | "away"): Promise<{ status: string; expiresInSec: number }> {
    return call("/agent/presence", post({ status }));
  },
  cannedPicker(): Promise<CannedPick[]> {
    return call<CannedPick[]>("/agent/canned-replies", { method: "GET" });
  },
  /** One canned reply filled for this thread, in its user's language — text for the box, nothing stored. */
  canned(id: string, replyId: string): Promise<{ body: string; lang: string }> {
    return call(`${agentThread(id)}/canned-replies/${encodeURIComponent(replyId)}`, { method: "GET" });
  },
};

// ------------------------------------------------ the admin's settings (F-033-p)

/** `GET …/settings/hours`: minutes of the tenant's own wall clock, weekday 0 = Sunday. */
export interface SupportHours {
  zone: string;
  intervals: Array<{ weekday: number; startMinute: number; endMinute: number }>;
}

export interface SlaTarget {
  priority: SupportPriority;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  source?: "tenant" | "platform";
}

export interface CategoryText {
  lang: string;
  name: string;
}

export interface AdminCategory {
  id: string;
  key: string;
  sortOrder: number;
  isActive: boolean;
  texts: CategoryText[];
  /** A conversation names it: retire, never delete. */
  inUse: boolean;
}

export interface CategoryList {
  own: AdminCategory[];
  platform: { id: string; key: string; name: string }[];
  /** No active category of the tenant's own: its users are offered `platform`. */
  usingPlatform: boolean;
}

const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", body: JSON.stringify(body) });

export const supportSettingsApi = {
  hours(): Promise<SupportHours> {
    return call<SupportHours>("/settings/hours", { method: "GET" });
  },
  /** Replaces the whole week; `[]` = always open (presence alone decides). */
  saveHours(intervals: Array<{ weekday: number; start: string; end: string }>): Promise<SupportHours> {
    return call<SupportHours>("/settings/hours", put({ intervals }));
  },
  sla(): Promise<SlaTarget[]> {
    return call<SlaTarget[]>("/settings/sla", { method: "GET" });
  },
  /** Replaces the tenant's own whole; a priority left out is the platform's. */
  saveSla(targets: SlaTarget[]): Promise<SlaTarget[]> {
    return call<SlaTarget[]>("/settings/sla", put({ targets: targets.map(({ priority, firstResponseMinutes, resolutionMinutes }) => ({ priority, firstResponseMinutes, resolutionMinutes })) }));
  },
  categories(): Promise<CategoryList> {
    return call<CategoryList>("/settings/categories", { method: "GET" });
  },
  createCategory(body: { key: string; texts: CategoryText[]; sortOrder?: number; isActive?: boolean }): Promise<AdminCategory> {
    return call<AdminCategory>("/settings/categories", post(body));
  },
  updateCategory(id: string, body: Partial<{ key: string; texts: CategoryText[]; sortOrder: number; isActive: boolean }>): Promise<AdminCategory> {
    return call<AdminCategory>(`/settings/categories/${encodeURIComponent(id)}`, patch(body));
  },
  /** Only one no conversation names; otherwise `category_in_use` — retire it. */
  removeCategory(id: string): Promise<void> {
    return call<void>(`/settings/categories/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
};
