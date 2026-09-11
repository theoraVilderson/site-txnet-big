// Browser calls api.${DOMAIN_NAME} directly (cross-origin, cookie-bearing) —
// no Next.js proxy hop. Backend CORS (main.ts) allows this origin with
// credentials; see docs/interfaces/auth-api/contract.md.
import { ApiError } from "./api-error";
import { apiLanguage } from "./api-language";

const API_URL = `${process.env.NEXT_PUBLIC_API_ORIGIN}/api`;
let accessToken: string | null = null;

/**
 * The access token lives in memory only, so a full page load starts with none
 * — but the httpOnly `refresh_token` cookie is still there. `ensureSession()`
 * turns that cookie back into an access token exactly once per page load.
 *
 * Once, not per caller: refresh *rotates* the token, so two concurrent calls
 * race and the loser is handed a token that no longer resolves to a session.
 * React Strict Mode alone is enough to produce that pair.
 */
let sessionBootstrap: Promise<AuthResult> | null = null;

/**
 * Every call goes out with the language the user chose in this panel and comes
 * back as either `data` or an {@link ApiError}. `auth-api` has already
 * translated `msg` and each `fieldErrors[].message` into that language, so a
 * caller shows them as they are; the two answers with no server text of their
 * own (`fetch` threw, or the body had no envelope) are marked `unreachable` and
 * the caller translates its own line.
 */
async function request<T>(path: string, init: RequestInit = {}, captchaToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const lang = apiLanguage();
  if (lang) headers.set("accept-language", lang);
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (captchaToken) headers.set("x-captcha-token", captchaToken);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  } catch (cause) {
    throw ApiError.unreachable(`${init.method ?? "GET"} ${path} did not reach auth-api`, cause);
  }

  const body = await response.json().catch(() => null);
  if (body === null || typeof body !== "object") {
    // A 2xx whose body cannot be read is still a success — an empty answer to
    // a call that wanted nothing back. A failure with no readable body has no
    // message in it, so nothing translated came back to show.
    if (!response.ok) {
      throw ApiError.unreachable(`${path} answered ${response.status} without a JSON envelope`);
    }
    return undefined as T;
  }
  if (!response.ok || body.ok === false) {
    // No `msg` means nothing translated came back — a bare gateway 502, say.
    if (typeof body.msg !== "string" || body.msg.length === 0) {
      throw ApiError.unreachable(`${path} answered ${response.status} with no message`);
    }
    throw new ApiError(body.msg, {
      status: response.status,
      ref: typeof body.ref === "string" ? body.ref : undefined,
      fieldErrors: Array.isArray(body.fieldErrors)
        ? (body.fieldErrors as unknown[])
            .map((f) => f as { path?: unknown; message?: unknown })
            .filter((f) => typeof f?.message === "string")
            .map((f) => ({ path: String(f.path ?? ""), message: f.message as string }))
        : [],
    });
  }
  return body.data as T;
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
  async refresh() { const result = await request<AuthResult>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }); accessToken = result.accessToken; return result; },
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
      sessionBootstrap = Promise.resolve(result as AuthResult);
    } else {
      accessToken = null;
      sessionBootstrap = null;
    }
    return result;
  },
  /**
   * Sign out of **every** account this browser holds (`F-0211`).
   *
   * The deliberate one, and never the same button as `logout()` — see
   * `SignOutEverywhere`, which asks first.
   */
  async logoutAll() { const result = await request<{ success: boolean }>("/auth/logout/all", { method: "POST", body: JSON.stringify({}) }); accessToken = null; sessionBootstrap = null; return result; },
  /** An access token for this page load, from the refresh cookie. Throws if there is no live session. */
  async ensureSession() { sessionBootstrap ??= authApi.refresh(); return sessionBootstrap; },
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
    const result = await request<{ state: "authenticated" | "needsContact" } & Partial<AuthResult>>(
      "/auth/bots/webapp/session",
      { method: "POST", body: JSON.stringify({ platform, initData }) },
    );
    if (result.accessToken) { accessToken = result.accessToken; sessionBootstrap = Promise.resolve(result as AuthResult); }
    return result;
  },
  /** The caller's own account plus the accounts they may switch to (F-0206). */
  async listAccounts() { return request<SwitchGroup>("/auth/accounts", { method: "GET" }); },
  /**
   * Add another account to the group (F-0205) — proved by a code sent to that
   * account's own phone, or by that account's own password.
   */
  async addAccountOtpRequest(phoneNumber: string, channel?: OtpChannel) { return request<OtpRequestResult>("/auth/accounts/add/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }); },
  async addAccountOtpVerify(phoneNumber: string, otpCode: string) { return request<{ groupId: string; added: boolean }>("/auth/accounts/add/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  async addAccountPassword(identifier: string, password: string) { return request<{ groupId: string; added: boolean }>("/auth/accounts/add/password", { method: "POST", body: JSON.stringify({ identifier, password }) }); },
  /**
   * Become another member (F-0207). The session this tab is holding is revoked
   * server-side by this call, so the returned token replaces it here — there is
   * no moment where the old one is still usable.
   */
  async switchAccount(userId: string) { const result = await request<AuthResult & { userId: string; fullName: string }>("/auth/accounts/switch", { method: "POST", body: JSON.stringify({ userId }) }); accessToken = result.accessToken; sessionBootstrap = null; return result; },
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
