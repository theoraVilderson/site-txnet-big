// Browser calls auth-service at `/api/auth` on the page's own domain, which
// Traefik routes to the service — no Next.js proxy hop, and no CORS: the
// refresh cookie is first-party to whichever domain the panel is on (ADR-0060).
import { RequestHeaders } from "@/generated/wire";
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";

const API_URL = API_BASE;
let accessToken: string | null = null;

/**
 * **One refresh for the whole browser.** Refresh *rotates* the session: the one
 * it replaces is revoked on the spot. So two refreshes racing with the same
 * cookie sign the loser out, and a tab that refreshes retires the token every
 * other tab holds. Three things make calls, the socket and several tabs live on
 * one session:
 *
 * - in this tab, every refresh — a refused call, the socket, a stale role — is
 *   the same in-flight promise;
 * - across tabs, `navigator.locks` lets one refresh run at a time;
 * - the new token is broadcast (memory to memory, never storage), and a tab
 *   adopts it when it names the same user, so it retries on it instead of
 *   rotating the session out from under the tab that just refreshed.
 *
 * `/auth/refresh` itself is neither behind the gate nor behind `AuthGuard`, so
 * it can never answer a refusal this retries and this can never wait on itself.
 */
let credentialRefresh: Promise<void> | null = null;

/** Any refresh in flight — the page load's or a later one — settled either way. */
let pending: Promise<void> | null = null;
function track<T>(p: Promise<T>): Promise<T> {
  const settled = p.then(
    () => undefined,
    () => undefined,
  );
  pending = settled;
  void settled.then(() => {
    if (pending === settled) pending = null;
  });
  return p;
}
/**
 * The panel's page load, held open until `PanelSessionProvider` has a session
 * or knows it has none. React runs a child's effect before its parent's, so a
 * sidebar entry fetching on mount went out before the page-load refresh had
 * even started — tokenless, refused 401, then retried. The provider opens this
 * from a layout effect, which runs before any child's `useEffect`; every
 * tokenless call waits for it, and nothing is sent to be refused.
 */
let sessionHold: { settled: Promise<void>; release: () => void } | null = null;
function holdUntilSession(): void {
  if (accessToken || sessionHold) return;
  let release!: () => void;
  const settled = new Promise<void>((r) => (release = r));
  sessionHold = { settled, release };
}
function releaseSessionHold(): void {
  sessionHold?.release();
  sessionHold = null;
}

const credentialSettled = (): Promise<void> =>
  Promise.all([sessionHold?.settled, pending]).then(() => undefined);

/** Told after each refresh, so what was rendered from the old token (`me`) is read again. */
const permissionsRefreshed = new Set<() => void>();

const AUTH_CHANNEL = "txnet:auth";
const REFRESH_LOCK = "txnet:auth-refresh";

const channel: BroadcastChannel | null = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(AUTH_CHANNEL);
// A channel keeps Node's event loop alive; a browser has no `unref`.
(channel as unknown as { unref?: () => void } | null)?.unref?.();

/** The `sub` a token names, read without verifying — only to tell whose token a broadcast carries. */
function subjectOf(token: string | null): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

if (channel) {
  channel.onmessage = (event: MessageEvent) => {
    const next = (event.data as { accessToken?: unknown } | null)?.accessToken;
    // Another user's token is another account signed in elsewhere, not a rotation of ours.
    if (typeof next === "string" && accessToken && subjectOf(next) === subjectOf(accessToken)) {
      accessToken = next;
    }
  };
}

function withRefreshLock(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: LockManager }).locks;
  return locks ? locks.request(REFRESH_LOCK, fn).then(() => undefined) : fn();
}

/**
 * Leave `accessToken` live. `stale` is the token a refused call carried: when
 * it has already been replaced — here, or by a broadcast — there is nothing to
 * refresh, and refreshing anyway would rotate the session again.
 */
function refreshCredential(stale: string | null = null): Promise<void> {
  // Replaced already — or the call carried none and a token has arrived since:
  // a sidebar call sent before the page-load refresh started, refused after it
  // finished. Rotating again would revoke the token that refresh just handed out.
  if (accessToken && accessToken !== stale) return Promise.resolve();
  // No token was sent while one is being established: that one is the answer.
  // A second refresh with the same cookie would sign the first out.
  if (!stale && pending) {
    return pending.then(() => (accessToken ? undefined : refreshCredential(stale)));
  }
  credentialRefresh ??= withRefreshLock(async () => {
    // Another tab may have rotated while this one waited for the lock.
    if (accessToken && accessToken !== stale) return;
    await authApi.refresh();
    for (const listener of permissionsRefreshed) listener();
  }).finally(() => {
    credentialRefresh = null;
  });
  return credentialRefresh;
}

/**
 * Every call goes out with the language the user chose in this panel and comes
 * back as either `data` or an `ApiError` — {@link createApiClient} is where that
 * envelope is read, for this service and for `billing-api` alike.
 *
 * The credential is a callback rather than the value, because `accessToken`
 * above is reassigned by half the methods below: a client built with the value
 * would keep sending the token this module was loaded with.
 */
const call = createApiClient({
  baseUrl: API_URL,
  service: "auth-api",
  credential: () => accessToken,
  onCredentialRefused: (stale) => refreshCredential(stale),
  // `/auth/refresh` itself must not wait on the refresh it is.
  credentialSettled: () => credentialSettled(),
});

/**
 * `/auth/refresh` alone: no retry and no waiting for a credential, because it
 * *is* the thing every other call waits for and retries on.
 */
const rawCall = createApiClient({ baseUrl: API_URL, service: "auth-api", credential: () => accessToken });
function rawRequest<T>(path: string, init: RequestInit): Promise<T> {
  return rawCall<T>(path, init);
}

async function request<T>(path: string, init: RequestInit = {}, captchaToken?: string): Promise<T> {
  return call<T>(path, init, captchaToken ? { [RequestHeaders.captchaToken]: captchaToken } : undefined);
}

export type AuthResult = { accessToken: string; expiresIn: number };
export type CaptchaChallenge = { challengeId: string };
export type CaptchaPass = { token: string; expiresIn: number };

/** Delivery methods the *server* offers — never hard-code this list. */
export type OtpChannel = "sms" | "telegram" | "bale";
export type OtpChannelDescriptor = { channel: OtpChannel; requiresLink: boolean };

/**
 * A messenger channel the user has not connected yet: instead of a code, the
 * server hands back a deep link into the bot. The code is sent by the bot
 * itself once the user shares their contact there, so the screen polls
 * `botLinkStatus` and moves on when it reports `linked`.
 */
export type BotLinkRequired = {
  accepted: true;
  linkRequired: true;
  platform: "telegram" | "bale";
  linkToken: string;
  deepLink: string;
  expiresIn: number;
};
export type OtpRequested = { accepted: boolean; linkRequired?: undefined };
export type OtpRequestResult = OtpRequested | BotLinkRequired;

/**
 * The three handles every route that queues a code answers with (`auth-api`
 * v14). They address two different things: `deliveryId` reads the record, and
 * `channel` + `channelToken` hear the same answer sooner, over the socket.
 *
 * They are minted before the route knows whether there is an account behind
 * the number — which is what keeps a 202 from being an account-existence
 * oracle, and it is why a status still on `queued` means *not yet*, never *no
 * such number*.
 */
export type OtpDeliveryHandles = {
  deliveryId: string;
  /** A realtime channel name, `otp:<channelId>` — subscribed to verbatim. */
  channel: string;
  /** The proof `gateway-service` demands before it will serve that channel. */
  channelToken: string;
};
export type OtpDeliveryState = "queued" | "sent" | "failed";
/** `failureKey` is a machine key on `failed` only; the screen maps it itself. */
export type OtpDeliveryStatus = { state: OtpDeliveryState; failureKey?: string };

/** A code was queued: 202, with the handles that say what became of it. */
export type OtpQueued = { accepted: true; linkRequired?: undefined } & OtpDeliveryHandles;
/**
 * The `linkRequired` half carries **no handles**, deliberately: nothing was
 * queued, because the bot sends the code itself once the user shares their
 * contact there.
 */
export type OtpQueuedResult = OtpQueued | BotLinkRequired;
/**
 * One account in the caller's switch group (F-0206). The phone arrives already
 * masked — the server never sends the full number to this page, because the
 * switcher is rendered wherever the user happens to be sitting.
 */
export type SwitchAccount = {
  userId: string;
  fullName: string;
  phoneMasked: string | null;
};
export type SwitchGroup = {
  groupId: string | null;
  current: SwitchAccount;
  members: SwitchAccount[];
};

/**
 * Who this caller is and what it may do (F-097).
 *
 * `permissions` is the list the access token carries, which is the same list
 * `forward-auth` gates every request on — so a surface that hides an entry the
 * caller does not hold is hiding exactly what the edge would refuse. `tenant.type`
 * is the second door an operator surface needs: `settlement.manage` on a
 * reseller's own role does not make that reseller the platform owner.
 */
export type Me = {
  userId: string;
  fullName: string;
  role: { id: string; name: string };
  permissions: string[];
  /** `isOwner`: the caller is the tenant's owner (F-019-f). */
  tenant: { id: string; type: "platform_owner" | "reseller"; isOwner: boolean };
  /** Always verified when present: only *confirm email* writes it (F-035-g). */
  email: string | null;
  isImpersonated: boolean;
  impersonatedBy?: string;
};

/**
 * One user as `GET /auth/users` answers (F-018-ad): enough to tell two people
 * apart and to see one is suspended — never the number, never an email.
 */
export type UserSearchHit = {
  id: string;
  fullName: string;
  username: string | null;
  phoneMasked: string | null;
  status: "active" | "suspended" | "banned";
};

export type BotLinkStatus = {
  state: "pending" | "linked" | "failed";
  otpSent: boolean;
  failureKey?: string;
};

export const authApi = {
  async loginPassword(identifier: string, password: string, captchaToken: string) {
    const result = await request<AuthResult | ({ requiresOtp: true; otpToken: string } & OtpDeliveryHandles)>("/auth/login/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken);
    if ("accessToken" in result) accessToken = result.accessToken;
    return result;
  },
  /** The delivery methods this deployment has switched on. */
  async otpChannels() { return request<{ channels: OtpChannelDescriptor[] }>("/auth/otp/channels", { method: "GET" }); },
  async requestLoginOtp(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpQueuedResult>("/auth/login/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyLoginOtp(phoneNumber: string, otpCode: string) { const result = await request<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async register(input: { fullName: string; username: string; phoneNumber: string; password: string }, captchaToken: string, channel?: OtpChannel) { return request<({ phoneNumber: string; requiresPhoneVerification: boolean } & OtpDeliveryHandles & { linkRequired?: undefined }) | ({ phoneNumber: string; requiresPhoneVerification: boolean } & BotLinkRequired)>("/auth/register", { method: "POST", body: JSON.stringify({ ...input, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyPhone(phoneNumber: string, otpCode: string) { const result = await request<AuthResult & { userId: string }>("/auth/register/verify-phone", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async forgot(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpQueuedResult>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyForgot(phoneNumber: string, otpCode: string) { return request<{ resetToken: string }>("/auth/password/forgot/verify-otp", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  /**
   * Resetting revokes every session the account had and returns a fresh one
   * for this device, so the user lands signed in here and signed out
   * everywhere else.
   */
  async reset(resetToken: string, newPassword: string) { const result = await request<{ success: boolean } & AuthResult>("/auth/password/reset", { method: "POST", body: JSON.stringify({ resetToken, newPassword }) }); if (result.accessToken) accessToken = result.accessToken; return result; },
  /**
   * What became of one queued code (`auth-api` v13, D-15).
   *
   * The record, not a notification about it: a screen whose socket never
   * opened, or that reconnected past the push, reads this. An id nobody minted
   * and one whose 300s life has passed both answer `queued`, which is the same
   * answer a slow provider gives — see {@link OtpDeliveryHandles}.
   */
  async otpDeliveryStatus(deliveryId: string) { return request<OtpDeliveryStatus>("/auth/otp/delivery/status", { method: "POST", body: JSON.stringify({ deliveryId }) }); },
  /** Has the user finished linking in the messenger yet? */
  async botLinkStatus(linkToken: string) { return request<BotLinkStatus>("/auth/bots/link/status", { method: "POST", body: JSON.stringify({ linkToken }) }); },
  async refresh() {
    const result = await track(rawRequest<AuthResult>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }));
    accessToken = result.accessToken;
    // Every rotation retires the token the other tabs hold; hand them this one.
    channel?.postMessage({ accessToken: result.accessToken });
    return result;
  },
  /**
   * Sign out of the account this browser is holding.
   *
   * ADR-0035: when the place still holds another account the user proved, the
   * server **falls back onto it** and answers with that account's session
   * rather than nothing. So this does not always end in the login screen — the
   * caller reads `switchedTo` to tell the two outcomes apart.
   */
  async logout() {
    const result = await request<{ success: boolean; switchedTo?: { userId: string; fullName: string } } & Partial<AuthResult>>(
      "/auth/logout",
      { method: "POST", body: JSON.stringify({}) },
    );
    if (result.switchedTo && result.accessToken) {
      accessToken = result.accessToken;
    } else {
      accessToken = null;
    }
    return result;
  },
  /**
   * Sign out of **every** account this browser holds (`F-0211`).
   *
   * The deliberate one, and never the same button as `logout()` — see
   * `SignOutEverywhere`, which asks first.
   */
  async logoutAll() { const result = await request<{ success: boolean }>("/auth/logout/all", { method: "POST", body: JSON.stringify({}) }); accessToken = null; return result; },
  /** An access token for this page load, from the refresh cookie. Throws if there is no live session. */
  /**
   * The access token lives in memory only, so a full page load starts with none
   * — but the httpOnly `refresh_token` cookie is still there. This turns it back
   * into one through the same shared, cross-tab-locked refresh every refused
   * call uses: a page-load refresh of its own raced them with the same cookie,
   * and the loser — sometimes this one — was signed out. A token a sign-in on
   * this page already left is live, so nothing is rotated then.
   */
  async ensureSession(): Promise<void> { if (!accessToken) await refreshCredential(); },
  /**
   * Sign in from inside a messenger's Mini App (F-310, ADR-0017).
   *
   * `initData` is a string the messenger signed with the bot's own token; the
   * server verifies it and answers with the ordinary session — the same cookie
   * and the same access token a password login produces, so nothing past this
   * line knows the panel is in a webview.
   *
   * `state: "needsContact"` is a refusal with a cause: this messenger account
   * has never shared its number with the bot, so the platform's signature says
   * who is looking but nothing yet says which account that is. It carries no
   * token, and the caller falls through to the ordinary login screen.
   */
  async webAppSession(platform: "telegram" | "bale", initData: string) {
    // Raw, like `/auth/refresh`: it *is* the session every held call waits for.
    const result = await rawRequest<{ state: "authenticated" | "needsContact" } & Partial<AuthResult>>(
      "/auth/bots/webapp/session",
      { method: "POST", body: JSON.stringify({ platform, initData }) },
    );
    if (result.accessToken) accessToken = result.accessToken;
    return result;
  },
  /** The caller's own account plus the accounts they may switch to (F-0206). */
  async listAccounts() { return request<SwitchGroup>("/auth/accounts", { method: "GET" }); },
  /** The resellers the caller owns — one "my reseller panel" entry each (F-061-f). */
  async ownedResellers() { return request<{ resellers: { id: string; slug: string }[] }>("/auth/handoff", { method: "GET" }); },
  /** A single-use code for one of them, and the origin of its panel to spend it on. */
  async issueHandoff(tenantId: string) { return request<{ origin: string; code: string; expiresIn: number }>("/auth/handoff", { method: "POST", body: JSON.stringify({ tenantId }) }); },
  /** Spend that code on the reseller's own domain: the same session a password sign-in opens. */
  async redeemHandoff(code: string) { const result = await request<AuthResult>("/auth/handoff/redeem", { method: "POST", body: JSON.stringify({ code }) }); accessToken = result.accessToken; return result; },
  /** The caller's own identity and authority (F-097). */
  async me() { return request<Me>("/auth/me", { method: "GET" }); },
  /** The platform owner finds a user by phone, username or email (F-018-ad): `user.search` on the platform's tenant. */
  async searchUsers(q: string) { return request<{ users: UserSearchHit[] }>(`/auth/users?q=${encodeURIComponent(q)}`, { method: "GET" }); },
  /** Mails a code to `email` (F-035-g); nothing is written until `confirmEmail`. */
  async requestEmailCode(email: string) { return request<OtpQueued>("/auth/me/email", { method: "POST", body: JSON.stringify({ email }) }); },
  async confirmEmail(email: string, otpCode: string) { return request<{ email: string; emailVerifiedAt: string }>("/auth/me/email/verify", { method: "POST", body: JSON.stringify({ email, otpCode }) }); },
  /** The one refresh every client and the socket run (see `credentialRefresh`). */
  refreshCredential,
  /** Hold every tokenless call until `releaseSessionHold` — the panel's page load (see `sessionHold`). */
  holdUntilSession,
  releaseSessionHold,
  /** Resolves once no credential is being established; a call with none waits on it. */
  credentialSettled,
  /**
   * Run `listener` after each such refresh; returns the unsubscribe. The panel
   * session re-reads `me` here, so the menu follows the gate.
   */
  onPermissionsRefreshed(listener: () => void) {
    permissionsRefreshed.add(listener);
    return () => {
      permissionsRefreshed.delete(listener);
    };
  },
  /**
   * Add another account to the group (F-0205) — proved by a code sent to that
   * account's own phone, or by that account's own password.
   */
  async addAccountOtpRequest(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpRequestResult>("/auth/accounts/add/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async addAccountOtpVerify(phoneNumber: string, otpCode: string) { return request<{ groupId: string; added: boolean }>("/auth/accounts/add/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  async addAccountPassword(identifier: string, password: string, captchaToken: string) { return request<{ groupId: string; added: boolean }>("/auth/accounts/add/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken); },
  /**
   * Become another member (F-0207). The session this tab is holding is revoked
   * server-side by this call, so the returned token replaces it here — there is
   * no moment where the old one is still usable.
   */
  async switchAccount(userId: string) { const result = await request<AuthResult & { userId: string; fullName: string }>("/auth/accounts/switch", { method: "POST", body: JSON.stringify({ userId }) }); accessToken = result.accessToken; return result; },
  /**
   * Remove a member from the group (F-0208).
   *
   * Scoped to **this browser** (ADR-0015): the group the server changes is the
   * one this browser's `device_id` cookie names, so nothing here touches a set
   * the same person built inside a bot chat.
   *
   * `userId` may be the current account, which is how it leaves — and that case
   * revokes this browser's own session, so the caller must reload rather than
   * carry on with a token the server has already dropped.
   */
  async removeAccount(userId: string) { return request<{ userId: string; removed: boolean }>("/auth/accounts/remove", { method: "POST", body: JSON.stringify({ userId }) }); },
  getAccessToken() { return accessToken; },
  // Server-verified slide challenge (F-0201) — see docs/interfaces/auth-api/contract.md
  async captchaChallenge() { return request<CaptchaChallenge>("/auth/captcha/challenge", { method: "POST", body: JSON.stringify({}) }); },
  async captchaVerify(challengeId: string) { return request<CaptchaPass>("/auth/captcha/verify", { method: "POST", body: JSON.stringify({ challengeId }) }); },
};

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

/** A user group as `/auth/user-groups` answers it (F-114-j, `auth-api/contract.user-groups.md`). */
export type UserGroup = {
  id: string;
  name: string;
  kind: "manual";
  /** The platform owner's only: every reseller is a member. */
  allTenants: boolean;
  userCount: number;
  tenantCount: number;
  createdAt: string;
  updatedAt: string;
};

/** One member. `label` is a user's name or a reseller's slug — never a phone. */
export type UserGroupMember = {
  memberType: "user" | "tenant";
  userId: string | null;
  tenantId: string | null;
  label: string | null;
  addedAt: string;
};

/** One user as a reseller's own list answers it (F-311-a, `contract.reseller-users.md`). */
export type ResellerUser = UserSearchHit & { createdAt: string };

/** A reseller's own users, by the **path's** tenant (F-311-a) — never the session's, which is the platform's for its owner (ADR-0059). */
export const resellerUsersApiPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/users`;

/**
 * `GET /api/auth/tenants/:tenantId/users` (F-311-a,
 * [auth-api/contract.reseller-users.md](../../../docs/interfaces/auth-api/contract.reseller-users.md)):
 * newest first, `q` 3-64 characters or none. Admitted under `read`, so a
 * suspended reseller still lists its customers. Block and unblock are
 * `staffWrite`: a suspended reseller is refused them.
 */
/** One user's block (F-311-a): `POST` blocks, `DELETE` lifts it — unblock is the deletion of the block. */
export const resellerUserBlockPath = (tenantId: string, userId: string) => `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/block`;

export const resellerUsersApi = {
  async list(tenantId: string, query: { q?: string; page: number; pageSize: number }) {
    const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
    if (query.q) params.set("q", query.q);
    return request<{ items: ResellerUser[]; total: number; page: number; pageSize: number }>(`${resellerUsersApiPath(tenantId)}?${params}`, { method: "GET" });
  },
  /** Answers the user at `suspended`, every session revoked; already blocked is the same 200. `staffWrite`. */
  async block(tenantId: string, userId: string) { return request<ResellerUser>(resellerUserBlockPath(tenantId, userId), { method: "POST" }); },
  /** Answers the user at `active`. */
  async unblock(tenantId: string, userId: string) { return request<ResellerUser>(resellerUserBlockPath(tenantId, userId), { method: "DELETE" }); },
};

const userGroupPath = (id: string) => `/auth/user-groups/${encodeURIComponent(id)}`;

export const userGroupsApi = {
  async list() { return request<UserGroup[]>("/auth/user-groups", { method: "GET" }); },
  async create(body: { name: string; allTenants?: boolean }) { return request<UserGroup>("/auth/user-groups", { method: "POST", body: JSON.stringify(body) }); },
  async update(id: string, body: { name?: string; allTenants?: boolean }) { return request<UserGroup>(userGroupPath(id), { method: "PATCH", body: JSON.stringify(body) }); },
  async remove(id: string) { return request<{ id: string; deleted: true }>(userGroupPath(id), { method: "DELETE" }); },
  async members(id: string, page: number, pageSize: number) {
    return request<{ items: UserGroupMember[]; total: number; page: number; pageSize: number }>(`${userGroupPath(id)}/members?page=${page}&pageSize=${pageSize}`, { method: "GET" });
  },
  async addMembers(id: string, body: { userIds?: string[]; tenantIds?: string[] }) { return request<{ added: number }>(`${userGroupPath(id)}/members`, { method: "POST", body: JSON.stringify(body) }); },
  async removeUser(id: string, userId: string) { return request<{ removed: true }>(`${userGroupPath(id)}/members/users/${encodeURIComponent(userId)}`, { method: "DELETE" }); },
  async removeTenant(id: string, tenantId: string) { return request<{ removed: true }>(`${userGroupPath(id)}/members/tenants/${encodeURIComponent(tenantId)}`, { method: "DELETE" }); },
  /** A reseller finds its own users (F-311-a); the door is `ResellerAccess`, not a permission key. */
  async resellerUsers(tenantId: string, q: string) {
    return request<{ items: ResellerUser[]; total: number }>(`/auth/tenants/${encodeURIComponent(tenantId)}/users?q=${encodeURIComponent(q)}&pageSize=10`, { method: "GET" });
  },
};
