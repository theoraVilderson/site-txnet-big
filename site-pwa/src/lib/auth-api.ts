// Browser calls api.${DOMAIN_NAME} directly (cross-origin, cookie-bearing) —
// no Next.js proxy hop. Backend CORS (main.ts) allows this origin with
// credentials; see docs/interfaces/auth-api/contract.md.
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

async function request<T>(path: string, init: RequestInit = {}, captchaToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (captchaToken) headers.set("x-captcha-token", captchaToken);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.msg ?? "Request failed");
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
    const result = await request<AuthResult | { requiresOtp: boolean }>("/auth/login/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken);
    if ("accessToken" in result) accessToken = result.accessToken;
    return result;
  },
  /** The delivery methods this deployment has switched on. */
  async otpChannels() { return request<{ channels: OtpChannelDescriptor[] }>("/auth/otp/channels", { method: "GET" }); },
  async requestLoginOtp(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpRequestResult>("/auth/login/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyLoginOtp(phoneNumber: string, otpCode: string) { const result = await request<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async register(input: { fullName: string; username: string; phoneNumber: string; password: string }, captchaToken: string, channel?: OtpChannel) { return request<({ phoneNumber: string; requiresPhoneVerification: boolean } & { linkRequired?: undefined }) | ({ phoneNumber: string; requiresPhoneVerification: boolean } & BotLinkRequired)>("/auth/register", { method: "POST", body: JSON.stringify({ ...input, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyPhone(phoneNumber: string, otpCode: string) { const result = await request<AuthResult & { userId: string }>("/auth/register/verify-phone", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async forgot(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpRequestResult>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyForgot(phoneNumber: string, otpCode: string) { return request<{ resetToken: string }>("/auth/password/forgot/verify-otp", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  /**
   * Resetting revokes every session the account had and returns a fresh one
   * for this device, so the user lands signed in here and signed out
   * everywhere else.
   */
  async reset(resetToken: string, newPassword: string) { const result = await request<{ success: boolean } & AuthResult>("/auth/password/reset", { method: "POST", body: JSON.stringify({ resetToken, newPassword }) }); if (result.accessToken) accessToken = result.accessToken; return result; },
  /** Has the user finished linking in the messenger yet? */
  async botLinkStatus(linkToken: string) { return request<BotLinkStatus>("/auth/bots/link/status", { method: "POST", body: JSON.stringify({ linkToken }) }); },
  async refresh() { const result = await request<AuthResult>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }); accessToken = result.accessToken; return result; },
  async logout() { const result = await request<{ success: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({}) }); accessToken = null; sessionBootstrap = null; return result; },
  /** An access token for this page load, from the refresh cookie. Throws if there is no live session. */
  async ensureSession() { sessionBootstrap ??= authApi.refresh(); return sessionBootstrap; },
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
