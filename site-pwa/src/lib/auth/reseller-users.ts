// A reseller's bots and its users, scoped by tenant id (F-066-w6, F-311-v).
import type { UserSearchHit } from "./account";
import { request } from "./credential";

/**
 * A reseller's bot as this surface answers it (F-066-w5): no token, no
 * `webhookPath`, no `credentialRef`. The webhook path is the bot's whole
 * address and therefore a credential (F-323, ADR-0009), which is also why a
 * retire names the bot by its `@handle`.
 */
export type ResellerBot = {
  id: string;
  platform: BotPlatformName;
  botUsername: string;
  role: "primary" | "sales" | "support" | "secondary";
  status: "pending" | "active" | "disabled" | "error";
};

export type BotPlatformName = "telegram" | "bale";

/**
 * The reseller's own bot routes, by the **path's** tenant and never the
 * session's: a reseller's owner signs in to the platform owner's tenant
 * (ADR-0059), so an ambient path would connect a bot to the platform.
 */
export const resellerBotApiPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/bots`;

/** A bot is named by its platform and `@handle` — the webhook path is not on the wire. */
export const resellerBotRetirePath = (tenantId: string, platform: string, botUsername: string) =>
  `${resellerBotApiPath(tenantId)}/${encodeURIComponent(platform)}/${encodeURIComponent(botUsername)}`;

/**
 * `/api/auth/tenants/:tenantId/bots` — list, connect, retire
 * ([auth-api/contract.reseller-bots.md](../../../docs/interfaces/auth-api/contract.reseller-bots.md)).
 * `registered: false` on a connect and `webhookRemoved: false` on a retire are
 * real outcomes the screen renders; neither is retried here.
 */
export const resellerBotsApi = {
  async list(tenantId: string) { return (await request<{ bots: ResellerBot[] }>(resellerBotApiPath(tenantId), { method: "GET" })).bots; },
  async connect(tenantId: string, body: { platform: BotPlatformName; token: string }) { return request<{ bot: ResellerBot; registered: boolean }>(resellerBotApiPath(tenantId), { method: "POST", body: JSON.stringify(body) }); },
  async retire(tenantId: string, platform: string, botUsername: string) { return request<{ retired: true; webhookRemoved: boolean }>(resellerBotRetirePath(tenantId, platform, botUsername), { method: "DELETE" }); },
};

/** One user as a reseller's own list answers it (F-311-a, `contract.reseller-users.md`). */
/** `statusReason`: what the person is shown for their status (ADR-0133). */
export type ResellerUser = UserSearchHit & {
  createdAt: string;
  statusReason?: string | null;
  /** The role they hold (F-1201-c). */
  role?: { id: string; name: string } | null;
};

/** A reseller's own users, by the **path's** tenant (F-311-a) — never the session's, which is the platform's for its owner (ADR-0059). */
export const resellerUsersApiPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/users`;

/**
 * `GET /api/auth/tenants/:tenantId/users` (F-311-a,
 * [auth-api/contract.reseller-users.md](../../../docs/interfaces/auth-api/contract.reseller-users.md)):
 * newest first, `q` 3-64 characters or none. Admitted under `read`, so a
 * suspended reseller still lists its customers. Block and unblock are
 * `staffWrite`: a suspended reseller is refused them.
 */
/** One user as the admin's user page reads them (AC-1-a): the list's row, and whether they have an email — masked. */
export type ResellerUserProfile = ResellerUser & { emailMasked: string | null; canAct: boolean; staff: boolean };

/** What the Profile tab may change (AC-1-a): name, username, and the email only removed — never written by staff. */
export type ResellerUserProfileEdit = { fullName?: string; username?: string; email?: null };

/** One user of the path's reseller (AC-1-a): `GET` reads them, `PATCH` edits their profile. */
export const resellerUserPath = (tenantId: string, userId: string) => `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}`;

/** One user's block (F-311-a): `POST` blocks, `DELETE` lifts it — unblock is the deletion of the block. */
export const resellerUserBlockPath = (tenantId: string, userId: string) => `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/block`;

export const resellerUsersApi = {
  /** `staff`: only the team — people whose role holds any permission (F-1201-c). */
  async list(tenantId: string, query: { q?: string; page: number; pageSize: number; staff?: boolean }) {
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
    if (query.q) params.set("q", query.q);
    if (query.staff) params.set("staff", "true");
    return request<{ items: ResellerUser[]; total: number; page: number; pageSize: number }>(`${resellerUsersApiPath(tenantId)}?${params}`, { method: "GET" });
  },
  /** Answers the user at `suspended`, every session revoked; already blocked is the same 200. `staffWrite`. */
  async block(tenantId: string, userId: string, reason?: string) { return request<ResellerUser>(resellerUserBlockPath(tenantId, userId), { method: "POST", body: JSON.stringify(reason ? { reason } : {}) }); },
  /** Answers the user at `active`. */
  async unblock(tenantId: string, userId: string) { return request<ResellerUser>(resellerUserBlockPath(tenantId, userId), { method: "DELETE" }); },
  /** One person, with `emailMasked` (AC-1-a). Admitted under `read`. */
  async profile(tenantId: string, userId: string) { return request<ResellerUserProfile>(resellerUserPath(tenantId, userId), { method: "GET" }); },
  /** Only changed fields; `{}` is a 400. `staffWrite` and authority over the person (ADR-0103). */
  async editProfile(tenantId: string, userId: string, body: ResellerUserProfileEdit) {
    return request<ResellerUserProfile>(resellerUserPath(tenantId, userId), { method: "PATCH", body: JSON.stringify(body) });
  },
};
