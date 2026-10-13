// The platform's support access to a reseller's people: consent and emergency entry (F-117-f, F-117-g).
import { request } from "./credential";

/** Prisma's `SupportConsentScope`: `read` sees a reseller's people, `act` also acts on them. */
export type ConsentScope = "read" | "act";

/** One request or grant (F-117-a); `state` is derived by the service on read, never here. */
export interface ConsentView {
  id: string;
  scope: ConsentScope;
  state: "requested" | "live" | "expired" | "revoked" | "declined";
  reason: string | null;
  requestedByUserId: string | null;
  requestedAt: string | null;
  grantedByUserId: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedByUserId: string | null;
  revokedAt: string | null;
}

/** One tier C entry (F-117-d): one hour, its entrant alone, never extended. */
export interface EmergencyEntryView {
  id: string;
  userId: string;
  reason: string;
  state: "live" | "ended" | "expired";
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
}

export interface SupportConsentList {
  defaultHours: number;
  items: ConsentView[];
  emergency: EmergencyEntryView[];
}

/** One request of the platform's staff among the reseller's people (F-117-c); `act` is the method and route template. */
export interface PlatformActivity {
  id: string;
  at: string;
  actorUserId: string;
  tier: string;
  consentId: string | null;
  entryId: string | null;
  scope: string | null;
  act: string;
  target: Record<string, string>;
}

/** `/auth/tenants/:id/support-consent` (audit `contract.md` "Support consent", F-117-a/c/d). */
export const supportConsentApiPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/support-consent`;

export const supportConsentApi = {
  async list(tenantId: string) { return request<SupportConsentList>(supportConsentApiPath(tenantId), { method: "GET" }); },
  /** The reseller's only (`reseller_only` to staff), 50 a page, newest first. */
  async activity(tenantId: string, page: number) { return request<{ page: number; items: PlatformActivity[] }>(`${supportConsentApiPath(tenantId)}/activity?page=${page}`, { method: "GET" }); },
  /** The reseller only; a `requestId` turns that request live on the scope given here. */
  async grant(tenantId: string, body: { scope: ConsentScope; hours?: number; requestId?: string }) { return request<ConsentView>(supportConsentApiPath(tenantId), { method: "POST", body: JSON.stringify(body) }); },
  /** Ends a request (declined / withdrawn) or a live grant. */
  async revoke(tenantId: string, consentId: string) { return request<ConsentView>(`${supportConsentApiPath(tenantId)}/${encodeURIComponent(consentId)}/revoke`, { method: "POST" }); },
  async setPolicy(tenantId: string, defaultHours: number) { return request<{ defaultHours: number }>(`${supportConsentApiPath(tenantId)}/policy`, { method: "PUT", body: JSON.stringify({ defaultHours }) }); },
  /** Platform staff only; one open request per reseller. */
  async request(tenantId: string, body: { scope: ConsentScope; reason: string }) { return request<ConsentView>(`${supportConsentApiPath(tenantId)}/requests`, { method: "POST", body: JSON.stringify(body) }); },
  /** `tenant.emergency_access` only; the owner is told at once. */
  async enterEmergency(tenantId: string, reason: string) { return request<EmergencyEntryView>(`${supportConsentApiPath(tenantId)}/emergency`, { method: "POST", body: JSON.stringify({ reason }) }); },
  async endEmergency(tenantId: string, entryId: string) { return request<EmergencyEntryView>(`${supportConsentApiPath(tenantId)}/emergency/${encodeURIComponent(entryId)}/end`, { method: "POST" }); },
};
