// Browser calls auth-service at `/api/auth` on the page's own domain, which
// Traefik routes to the service — no Next.js proxy hop, and no CORS: the
// refresh cookie is first-party to whichever domain the panel is on (ADR-0060).
import { RequestHeaders } from "@/generated/wire";
import type { UiPreferences, UiPreferencesPatch } from "@/stores/ui-preferences-store";
import { API_BASE } from "./api-origin";
import { createApiClient } from "./api-request";
import type { ResolvedTimeZone, TimeZoneSource } from "./time-zone";

const API_URL = API_BASE;
let accessToken: string | null = null;

/** "Sign in as this user" (AC-1-i): whom this tab is signed in as, until when, and the page to come back to. */
export type Impersonation = { userId: string; name: string; endsAt: number; returnTo: string };

/**
 * The impersonation this tab holds, and the admin's own token beside it.
 *
 * Memory only, like `accessToken` — a reload ends it, and the refresh cookie
 * (still the admin's: impersonation mints none) brings the admin back. It has
 * no refresh token, so a refusal a refresh would mend ends it instead
 * (`refreshCredential`), and the refused call is never sent again: a retry
 * would carry the admin's token and run the user's click as the admin.
 */
let impersonation: Impersonation | null = null;
/** The admin's own token, kept beside the user's while `impersonation` is set. */
let ownToken: string | null = null;
const impersonationListeners = new Set<() => void>();

/** The impersonation is over, on purpose or because its token was refused. */
export class ImpersonationEnded extends Error {
  constructor() {
    super("impersonation ended");
    this.name = "ImpersonationEnded";
  }
}

function backToOwnToken(): void {
  if (!impersonation) return;
  accessToken = ownToken;
  ownToken = null;
  impersonation = null;
  for (const listener of impersonationListeners) listener();
}

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
    if (typeof next !== "string") return;
    // Another tab rotated the admin's session: the token to come back to, not the one in use.
    if (impersonation) {
      if (ownToken && subjectOf(next) === subjectOf(ownToken)) ownToken = next;
      return;
    }
    // Another user's token is another account signed in elsewhere, not a rotation of ours.
    if (accessToken && subjectOf(next) === subjectOf(accessToken)) {
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
  // An impersonated token is never refreshed (it has no refresh token) and a
  // refused call is never retried on the admin's: it ends here (AC-1-i).
  if (impersonation) {
    backToOwnToken();
    return Promise.reject(new ImpersonationEnded());
  }
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

/**
 * A login, with no credential at all. auth-service refuses a login that
 * carries a live session's token (409 `alreadyAuthenticated`), and a tab can
 * hold one while this browser's refresh cookie is dead — a rotation whose
 * answer was lost, say, to an auth-service restart. The page-load check then
 * shows the form, and with the token attached every submit was refused: a
 * dead end. A login is never an authenticated call; sent bare, it mints the
 * fresh session and cookie the browser needs.
 */
const loginCall = createApiClient({ baseUrl: API_URL, service: "auth-api" });
function loginRequest<T>(path: string, init: RequestInit, captchaToken?: string): Promise<T> {
  return loginCall<T>(path, init, captchaToken ? { [RequestHeaders.captchaToken]: captchaToken } : undefined);
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
/**
 * One reseller the caller owns (`GET /auth/handoff`, F-061-f). `here`: this
 * request came through its own panel domain (F-061-m). `hasPanel`: a handoff
 * to it would land — it has a verified panel domain (F-061-n). `live`: not
 * terminated — an owner holds one at a time (`already_reseller`).
 */
export type OwnedReseller = { id: string; slug: string; here: boolean; hasPanel: boolean; live: boolean };

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
  /** Set while the account is restricted to support (ADR-0133), with the reason staff wrote. */
  restriction?: { reason: string | null } | null;
};

/**
 * One user as `GET /auth/users` answers (F-018-ad): enough to tell two people
 * apart and to see one is suspended — never the number, never an email.
 */
/** `identity.user.status` (ADR-0133): `suspended` is restricted to support, `banned` is out. */
export type AccountStatus = "active" | "suspended" | "banned";

export type UserStatusView = { id: string; status: AccountStatus; statusReason: string | null };

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

/** The messengers a user may take notices on (F-601-u); `both` is also what an unchosen one reads as. */
export const NOTICE_MESSENGERS = ["both", "telegram", "bale"] as const;
export type NoticeMessenger = (typeof NOTICE_MESSENGERS)[number];
/** `linked`: the platforms with a verified chat, so the panel can say which one is not linked yet. */
export type MeMessenger = { messenger: NoticeMessenger; chosen: boolean; linked: Array<"telegram" | "bale"> };

/** The caller's own zone and the one their dates are drawn in (TZ-1-c, auth-api `contract.time-zone.md`); `applied` on a save. */
export type MeTimeZone = { timezone: string | null; source: TimeZoneSource | null; resolved: ResolvedTimeZone; applied?: boolean };
/** One place the account is signed in (SES-1-a): a browser, or a bot chat with its Mini App. `id` is opaque. */
export type ActiveSession = {
  id: string;
  current: boolean;
  surface: "web" | "telegram" | "bale";
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: string;
};

export const authApi = {
  async loginPassword(identifier: string, password: string, captchaToken: string) {
    const result = await loginRequest<AuthResult | ({ requiresOtp: true; otpToken: string } & OtpDeliveryHandles)>("/auth/login/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken);
    if ("accessToken" in result) accessToken = result.accessToken;
    return result;
  },
  /** The delivery methods this deployment has switched on. */
  async otpChannels() { return request<{ channels: OtpChannelDescriptor[] }>("/auth/otp/channels", { method: "GET" }); },
  async requestLoginOtp(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return loginRequest<OtpQueuedResult>("/auth/login/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyLoginOtp(phoneNumber: string, otpCode: string) { const result = await loginRequest<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
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
  async ownedResellers() { return request<{ resellers: OwnedReseller[] }>("/auth/handoff", { method: "GET" }); },
  /** A single-use code for one of them, and the origin of its panel to spend it on. */
  async issueHandoff(tenantId: string) { return request<{ origin: string; code: string; expiresIn: number }>("/auth/handoff", { method: "POST", body: JSON.stringify({ tenantId }) }); },
  /**
   * Spend that code on the reseller's own domain. `alreadySignedIn`: this
   * domain already holds a live session of the same account, which is kept —
   * no new session, no token here (F-061-o); the panel restores it from its cookie.
   */
  async redeemHandoff(code: string) {
    const result = await request<AuthResult | { alreadySignedIn: true }>("/auth/handoff/redeem", { method: "POST", body: JSON.stringify({ code }) });
    if ("accessToken" in result) accessToken = result.accessToken;
    return result;
  },
  /** The caller's own identity and authority (F-097). */
  async me() { return request<Me>("/auth/me", { method: "GET" }); },
  /** The platform owner finds a user by phone, username or email (F-018-ad): `user.search` on the platform's tenant. */
  async searchUsers(q: string) { return request<{ users: UserSearchHit[] }>(`/auth/users?q=${encodeURIComponent(q)}`, { method: "GET" }); },
  /** Mails a code to `email` (F-035-g); nothing is written until `confirmEmail`. */
  async requestEmailCode(email: string) { return request<OtpQueued>("/auth/me/email", { method: "POST", body: JSON.stringify({ email }) }); },
  async confirmEmail(email: string, otpCode: string) { return request<{ email: string; emailVerifiedAt: string }>("/auth/me/email/verify", { method: "POST", body: JSON.stringify({ email, otpCode }) }); },
  /** Which messenger the caller's notices take (F-601-u); unchosen reads as `both`, with `chosen: false`. */
  async messenger() { return request<MeMessenger>("/auth/me/messenger", { method: "GET" }); },
  async saveMessenger(messenger: NoticeMessenger) { return request<MeMessenger>("/auth/me/messenger", { method: "PUT", body: JSON.stringify({ messenger }) }); },
  /** The caller's zone, and the resolved one dates are drawn in (TZ-1-c). */
  async timeZone() { return request<MeTimeZone>("/auth/me/timezone", { method: "GET" }); },
  /** `user` picks (null clears the pick); `browser` reports, and is not stored over a pick (`applied: false`). */
  async saveTimeZone(zone: string | null, source: TimeZoneSource) { return request<MeTimeZone>("/auth/me/timezone", { method: "PUT", body: JSON.stringify({ zone, source }) }); },
  /** The caller's display preferences, every key with defaults filled in (UX-1-k). */
  async uiPreferences() { return request<UiPreferences>("/auth/me/ui-preferences", { method: "GET" }); },
  /** Any subset, validated strictly; answers every key after the write. */
  async saveUiPreferences(patch: UiPreferencesPatch) { return request<UiPreferences>("/auth/me/ui-preferences", { method: "PATCH", body: JSON.stringify(patch) }); },
  /** Renames the caller (UX-1-t, auth-api v41): the register form's rules; `GET auth/me` then answers the new name. */
  async renameMe(fullName: string) { return request<{ fullName: string }>("/auth/me/name", { method: "PUT", body: JSON.stringify({ fullName }) }); },
  /** Changes the password signed in (UX-1-t): a wrong `currentPassword` is 400 `wrong_password`; this session stays. */
  async changePassword(currentPassword: string, newPassword: string, endOtherSessions: boolean) { return request<{ otherSessionsEnded: number }>("/auth/me/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword, endOtherSessions }) }); },
  /** Every place this account is signed in, the current one first (SES-1-a). */
  async activeSessions() { return request<{ sessions: ActiveSession[] }>("/auth/sessions", { method: "GET" }); },
  /** End that place for good: its sessions, its switcher entry, and — on a bot chat — this account's link to it. */
  async terminateSession(id: string) { return request<{ terminated: number }>("/auth/sessions/terminate", { method: "POST", body: JSON.stringify({ id }) }); },
  async terminateOtherSessions() { return request<{ terminated: number }>("/auth/sessions/terminate-others", { method: "POST" }); },
  /** The one refresh every client and the socket run (see `credentialRefresh`). */
  refreshCredential,
  /**
   * Rotate the token this tab holds because the person's access moved
   * (`identity.access.changed`, AC-1-r) — the same single-flight refresh as a
   * refused call, so `onPermissionsRefreshed` re-reads `me` after it.
   */
  refreshAccess: () => refreshCredential(accessToken),
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
  /** Where a person stands (BAN-1-d) — `restriction.assign` or `user.ban`, own tenant. */
  async userStatus(userId: string) { return request<UserStatusView>(`/auth/users/${encodeURIComponent(userId)}/status`, { method: "GET" }); },
  /** Restrict, ban or lift, with the reason the person is shown (ADR-0133). */
  async setUserStatus(userId: string, status: AccountStatus, reason?: string) { return request<UserStatusView>(`/auth/users/${encodeURIComponent(userId)}/status`, { method: "PUT", body: JSON.stringify({ status, reason }) }); },
  async addAccountOtpVerify(phoneNumber: string, otpCode: string) { return request<{ groupId: string; added: boolean; userId: string }>("/auth/accounts/add/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  async addAccountPassword(identifier: string, password: string, captchaToken: string) { return request<{ groupId: string; added: boolean; userId: string }>("/auth/accounts/add/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken); },
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
   * `userId` may be the current account, which is how it leaves. The browser
   * then falls back to another member — `switchedTo`, with a fresh token pair,
   * exactly as a switch — or, with none left, is signed out. Either way the old
   * token is dead, so the caller reloads rather than carry on with it.
   */
  async removeAccount(userId: string) {
    const result = await request<{ userId: string; removed: boolean; switchedTo?: { userId: string; fullName: string } } & Partial<AuthResult>>("/auth/accounts/remove", { method: "POST", body: JSON.stringify({ userId }) });
    if (result.accessToken) accessToken = result.accessToken;
    return result;
  },
  /**
   * Sign in as `userId` for at most 30 minutes (AC-1-i, catalog §3.6): the
   * caller's own tenant, or — `tenantId` — a reseller's user under its consent
   * (F-117-e). The reason, at least 10 characters, goes in the audit row.
   */
  async impersonate(input: { userId: string; name: string; reasonNote: string; tenantId?: string | null; returnTo: string }) {
    const path = input.tenantId
      ? `/auth/tenants/${encodeURIComponent(input.tenantId)}/users/${encodeURIComponent(input.userId)}/impersonate`
      : `/auth/users/${encodeURIComponent(input.userId)}/impersonate`;
    const result = await request<AuthResult>(path, { method: "POST", body: JSON.stringify({ reasonNote: input.reasonNote }) });
    impersonation = { userId: input.userId, name: input.name, endsAt: Date.now() + result.expiresIn * 1000, returnTo: input.returnTo };
    ownToken = accessToken;
    accessToken = result.accessToken;
    for (const listener of impersonationListeners) listener();
  },
  /** End it on the server, as the user, then come back to the own token whatever the server said. */
  async endImpersonation() {
    if (!impersonation) return;
    try {
      await rawRequest("/auth/impersonate/end", { method: "POST", body: JSON.stringify({}) });
    } catch {
      // Expired or already ended: the server's session is over either way.
    } finally {
      backToOwnToken();
    }
  },
  /**
   * The end, for a page being unloaded: `keepalive` outlives the document, and
   * nothing waits for it. The reload that follows starts from the cookie.
   */
  endImpersonationOnUnload() {
    if (!impersonation || typeof fetch === "undefined") return;
    void fetch(`${API_URL}/auth/impersonate/end`, {
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: "{}",
    }).catch(() => undefined);
  },
  /** What this tab is signed in as, or null for the caller's own account. The same object until it changes. */
  impersonation(): Impersonation | null {
    return impersonation;
  },
  /** Run `listener` when an impersonation starts or ends; returns the unsubscribe. */
  onImpersonationChange(listener: () => void) {
    impersonationListeners.add(listener);
    return () => {
      impersonationListeners.delete(listener);
    };
  },
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
  /** What the group gives its user members (AC-1-m). */
  access: UserGroupAccess;
  createdAt: string;
  updatedAt: string;
};

/** A role and/or extra keys a group gives its own tenant's user members (AC-1-m). */
export type UserGroupAccess = { roleId: string | null; roleName: string | null; keys: string[] };

/** One member. `label` is a user's name or a reseller's slug — never a phone. */
export type UserGroupMember = {
  memberType: "user" | "tenant";
  userId: string | null;
  tenantId: string | null;
  label: string | null;
  /** A user of the group's own tenant: holds whatever the group gives (AC-1-o). */
  receivesAccess: boolean;
  addedAt: string;
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

/** A role as a tenant's page reads it (F-1201-a): a template is read-only; `members` counts this tenant's holders. */
export interface TenantRole {
  id: string;
  name: string;
  isTemplate: boolean;
  isSystemRole: boolean;
  permissions: string[];
  members: number;
}

/** One permission as `GET /auth/permissions` answers it (AC-1-f), texts in the request's language. */
export interface PermissionEntry {
  key: string;
  label: string;
  description: string;
  platformOnly: boolean;
}

/** One area of the registry: the keys' first segment, labelled. */
export interface PermissionArea {
  area: string;
  label: string;
  permissions: PermissionEntry[];
}

/** A key given or taken on one person: which, why, by whom, since when (AC-1-l). */
export type KeyOverride = { key: string; reason: string; by: string; at: string };

/** One person's keys by source, and the answer they add up to (AC-1-l, ADR-0138). */
export type PersonKeys = {
  userId: string;
  keys: string[];
  role: { id: string; name: string; keys: string[] };
  /** Each group that gives them access, with every key it gives (AC-1-n). */
  groups: { id: string; name: string; keys: string[] }[];
  given: KeyOverride[];
  taken: KeyOverride[];
};

/** `…/users/:userId/keys`, or one key under it (AC-1-l). */
export const personKeysPath = (tenantId: string, userId: string, key?: string) =>
  `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/keys${key ? `/${encodeURIComponent(key)}` : ""}`;

export const tenantRolesApiPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/roles`;

/**
 * A tenant's roles on its own path (F-1201-a, ADR-0134,
 * [auth-api/contract.roles.md](../../../docs/interfaces/auth-api/contract.roles.md)):
 * the path's tenant, admitted by `ResellerAccess` — the owner of a reseller,
 * its seated admins, or platform staff (the platform's own tenant included).
 * `grantable` is what this caller may tick; `*` means every key.
 */
export const tenantRolesApi = {
  async list(tenantId: string) {
    return request<{ roles: TenantRole[]; grantable: string[] }>(tenantRolesApiPath(tenantId), { method: "GET" });
  },
  async create(tenantId: string, body: { name: string; permissions: string[] }) {
    return request<{ role: Omit<TenantRole, "members"> }>(tenantRolesApiPath(tenantId), { method: "POST", body: JSON.stringify(body) });
  },
  /** `permissions` is the whole set, never a diff. */
  async update(tenantId: string, roleId: string, body: { name?: string; permissions?: string[] }) {
    return request<{ role: Omit<TenantRole, "members"> }>(`${tenantRolesApiPath(tenantId)}/${encodeURIComponent(roleId)}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  /** 409 `role.inUse` while anyone holds it. */
  async remove(tenantId: string, roleId: string) {
    return request<{ id: string }>(`${tenantRolesApiPath(tenantId)}/${encodeURIComponent(roleId)}`, { method: "DELETE" });
  },
  /** One person's role: a role of this tenant or a template, held whole by the caller, over someone they have authority over. */
  async assign(tenantId: string, userId: string, roleId: string) {
    return request<{ userId: string; role: { id: string; name: string } }>(`${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId }),
    });
  },
  /** One person's keys by source (AC-1-l); the role door's `read`. */
  async keysOf(tenantId: string, userId: string) {
    return request<PersonKeys>(personKeysPath(tenantId, userId), { method: "GET" });
  },
  /** Give or take one key, with a reason; a give replaces a take of the same key and the reverse. */
  async setKey(tenantId: string, userId: string, key: string, body: { effect: "give" | "take"; reason: string }) {
    return request<PersonKeys>(personKeysPath(tenantId, userId, key), { method: "PUT", body: JSON.stringify(body) });
  },
  /** Lift a key given or taken: the role and groups decide it again. */
  async liftKey(tenantId: string, userId: string, key: string) {
    return request<PersonKeys>(personKeysPath(tenantId, userId, key), { method: "DELETE" });
  },
  /** The registry (AC-1-f): every key the platform knows, by area, labelled in the request's language. */
  async permissions() {
    return request<{ areas: PermissionArea[] }>("/auth/permissions", { method: "GET" });
  },
};

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

const userGroupPath = (id: string) => `/auth/user-groups/${encodeURIComponent(id)}`;

/**
 * A reseller's groups by the path (F-102-g-d): what its workspace's gateway
 * editor picks an audience from. Invariant 21 decides; read only.
 */
export const resellerUserGroupsApi = {
  async list(tenantId: string) { return request<UserGroup[]>(`/auth/tenants/${encodeURIComponent(tenantId)}/user-groups`, { method: "GET" }); },
};

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
  /** The **whole** access — a role or none, and every extra key (AC-1-m). */
  async setAccess(id: string, body: { roleId: string | null; keys: string[] }) { return request<UserGroup>(`${userGroupPath(id)}/access`, { method: "PUT", body: JSON.stringify(body) }); },
  async removeTenant(id: string, tenantId: string) { return request<{ removed: true }>(`${userGroupPath(id)}/members/tenants/${encodeURIComponent(tenantId)}`, { method: "DELETE" }); },
  /** A reseller finds its own users (F-311-a); the door is `ResellerAccess`, not a permission key. */
  async resellerUsers(tenantId: string, q: string) {
    return request<{ items: ResellerUser[]; total: number }>(`/auth/tenants/${encodeURIComponent(tenantId)}/users?q=${encodeURIComponent(q)}&pageSize=10`, { method: "GET" });
  },
};
