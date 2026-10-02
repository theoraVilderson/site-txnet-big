// The caller's own inbox, served by `notification-service` on `/api/notifications`
// on the page's own domain (ADR-0060), routed there by Traefik — the same shape
// as `billing-api.ts` and `tenant-api.ts`, with the access token as a Bearer
// header and `forward-auth` turning it into the `X-User-Id` every route here
// reads. No route names a user: whose inbox it is comes off the gate, so there
// is no id to pass and none to get wrong (`domains/notification/contract.md`).
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import { authApi } from "./auth-api";

const call = createApiClient({
  baseUrl: `${API_BASE}/notifications`,
  service: "notification-service",
  credential: () => authApi.getAccessToken(),
  onCredentialRefused: (stale) => authApi.refreshCredential(stale),
  // The top bar reads on mount, so it waits for the page-load session rather
  // than racing it with no token.
  credentialSettled: () => authApi.credentialSettled(),
});

/**
 * Prisma's `NotificationType` (`prisma/domains/notification.prisma`). Spelled
 * here as a union the way `tenant-api.ts` spells `TenantStatus`: C-04's
 * generated wire holds the headers and the realtime event names, not every
 * domain enum.
 *
 * A value not in this list is not an error — the panel renders it with the
 * neutral tone rather than dropping the row, because a type added on the
 * service side must never silently hide a message.
 */
export type NotificationType = "system_alert" | "admin_message" | "low_balance";

/** One inbox row. No `userId`: the caller already knows whose inbox it asked for. */
export interface NotificationItem {
  id: string;
  type: NotificationType | (string & {});
  /** Stored text — the producing unit rendered it in the user's language before it asked. */
  title: string;
  body: string;
  /** ISO-8601, or `null` while unread. */
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationItem[];
  page: number;
  pageSize: number;
  total: number;
  /**
   * Unread over the **whole** inbox, whatever the page or filter. It is the
   * badge's number, and the only one: a count taken from `items` would be
   * short for everyone with more unread rows than a page holds.
   */
  unreadCount: number;
}

export interface MarkedRead {
  /** Rows that actually changed. An id already read, missing, or another user's counts 0 alike. */
  marked: number;
  unreadCount: number;
}

export interface InboxQuery {
  page?: number;
  pageSize?: number;
  unreadOnly?: boolean;
}

/**
 * The retention notice kinds a user may mute (F-601-m) — shared-core's
 * `RETENTION_MUTABLE_KINDS`, spelled here in the same order. A stopped
 * service is not one: it is always told.
 */
export const NOTICE_KINDS = ["usage", "ending", "connect", "reactivated"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/** The caller's notice settings, read and replaced whole. Times are `HH:MM`; the window may wrap midnight. */
export interface NoticePreferences {
  muted: NoticeKind[];
  quietHours: { start: string; end: string } | null;
  /** IANA zone the window is read in; null = the user's own zone, whatever it becomes (TZ-1-f). */
  timezone: string | null;
}

/**
 * How much the caller is told about one service (F-601-o) — the service's
 * `GRANT_NOTICE_LEVELS`, spelled here in the same order. `essential` is the
 * cutoff notices alone: a stopped service, a purge, an admin's act.
 */
export const GRANT_NOTICE_LEVELS = ["all", "essential"] as const;
export type GrantNoticeLevel = (typeof GRANT_NOTICE_LEVELS)[number];

export const notificationApi = {
  /** A page of the caller's own inbox, newest first. */
  inbox(query: InboxQuery = {}): Promise<NotificationPage> {
    const search = new URLSearchParams();
    if (query.page !== undefined) search.set("page", String(query.page));
    if (query.pageSize !== undefined) search.set("pageSize", String(query.pageSize));
    if (query.unreadOnly !== undefined) search.set("unreadOnly", String(query.unreadOnly));
    const qs = search.toString();
    return call<NotificationPage>(qs ? `?${qs}` : "", { method: "GET" });
  },

  /**
   * Mark rows read. `undefined` marks every unread row the user has — the
   * route's own meaning for an absent `ids`, and the reason an empty list is
   * refused there rather than quietly meaning "all".
   */
  markRead(ids?: readonly string[]): Promise<MarkedRead> {
    return call<MarkedRead>("/read", {
      method: "POST",
      body: JSON.stringify(ids === undefined ? {} : { ids }),
    });
  },

  /** The caller's own notice settings (F-601-m); a user who never saved any reads the defaults. */
  preferences(): Promise<NoticePreferences> {
    return call<NoticePreferences>("/preferences", { method: "GET" });
  },

  /** Replace them whole; the answer is what was stored. */
  savePreferences(preferences: NoticePreferences): Promise<NoticePreferences> {
    return call<NoticePreferences>("/preferences", { method: "PUT", body: JSON.stringify(preferences) });
  },

  /** The caller's services told essentials only (F-601-o); every other one of theirs is `all`. */
  grantNoticeLevels(): Promise<{ essential: string[] }> {
    return call<{ essential: string[] }>("/preferences/grants", { method: "GET" });
  },

  /** Set one service's level; the answer is what was stored. */
  setGrantNoticeLevel(grantId: string, level: GrantNoticeLevel): Promise<{ grantId: string; level: GrantNoticeLevel }> {
    return call<{ grantId: string; level: GrantNoticeLevel }>(`/preferences/grants/${encodeURIComponent(grantId)}`, {
      method: "PUT",
      body: JSON.stringify({ level }),
    });
  },
};
