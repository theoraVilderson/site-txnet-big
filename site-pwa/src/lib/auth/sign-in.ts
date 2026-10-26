// Signing in and out: password, OTP and its delivery, register, reset, the Mini App, captcha (F-0201, F-310).
import { loginRequest, rawRequest, request, setAccessToken } from "./credential";
import type { OwnerSetupRequired } from "./owner-setup";

export type AuthResult = { accessToken: string; expiresIn: number };

export type CaptchaChallenge = { challengeId: string };

export type CaptchaPass = { token: string; expiresIn: number };

/** Delivery methods the *server* offers — never hard-code this list. */
export type OtpChannel = "sms" | "telegram" | "bale";

export type OtpChannelDescriptor = { channel: OtpChannel; requiresLink: boolean };

/**
 * A messenger channel the user has not connected yet: instead of a code, the
 * server hands back a deep link into the bot. The code is sent by the bot
 * itself once the user shares their contact there, so the screen hears
 * `channel` and re-reads `botLinkStatus` until it reports `linked` (RT-1-h).
 */
export type BotLinkRequired = {
  accepted: true;
  linkRequired: true;
  platform: "telegram" | "bale";
  linkToken: string;
  deepLink: string;
  expiresIn: number;
  /** `otp:<channelId>` — subscribed to verbatim, with `channelToken` as its proof. */
  channel: string;
  channelToken: string;
};

/** Seconds until another code may be asked for — on every code-sent answer, the server's own cooldown (`otpResendIn`). */
export type ResendIn = { resendIn?: number };

export type OtpRequested = { accepted: boolean; linkRequired?: undefined } & ResendIn;

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
} & ResendIn;

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

export type BotLinkStatus = {
  state: "pending" | "linked" | "failed";
  otpSent: boolean;
  failureKey?: string;
} & ResendIn;

/** Sign-in and sign-out calls — spread into `authApi` (`lib/auth-api.ts`). */
export const signInCalls = {
  async loginPassword(identifier: string, password: string, captchaToken: string) {
    const result = await loginRequest<AuthResult | { requiresOtp: true; chooseChannel: true; otpToken: string } | OwnerSetupRequired>("/auth/login/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken);
    if ("accessToken" in result) setAccessToken(result.accessToken);
    return result;
  },
  /** The delivery methods this deployment has switched on. */
  async otpChannels() { return request<{ channels: OtpChannelDescriptor[] }>("/auth/otp/channels", { method: "GET" }); },
  async requestLoginOtp(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return loginRequest<OtpQueuedResult>("/auth/login/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  /** Where the password step's code goes (SA-1-d): a code queued under a fresh token, or the bot link to connect first. */
  async sendSecondFactor(otpToken: string, channel?: OtpChannel) { return request<(OtpDeliveryHandles & { otpToken: string; linkRequired?: undefined }) | BotLinkRequired>("/auth/login/second-factor", { method: "POST", body: JSON.stringify({ otpToken, ...(channel ? { channel } : {}) }) }); },
  /** "Resend code" (F-0201-f): replays that step's send on the grant it wrote after its captcha. */
  async resendOtp(purpose: "login" | "register" | "forgot", phoneNumber: string, channel?: OtpChannel) { return request<OtpQueuedResult>("/auth/otp/resend", { method: "POST", body: JSON.stringify({ purpose, phoneNumber, ...(channel ? { channel } : {}) }) }); },
  /** The code after a password: sent with the password step's `otpToken`, never by number — that is a code-only sign-in (ADR-0145). */
  async verifySecondFactor(otpToken: string, otpCode: string) { const result = await loginRequest<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ otpToken, otpCode }) }); setAccessToken(result.accessToken); return result; },
  async verifyLoginOtp(phoneNumber: string, otpCode: string) { const result = await loginRequest<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); setAccessToken(result.accessToken); return result; },
  async register(input: { fullName: string; username: string; phoneNumber: string; password: string }, captchaToken: string, channel?: OtpChannel) { return request<({ phoneNumber: string; requiresPhoneVerification: boolean } & OtpDeliveryHandles & { linkRequired?: undefined }) | ({ phoneNumber: string; requiresPhoneVerification: boolean } & BotLinkRequired)>("/auth/register", { method: "POST", body: JSON.stringify({ ...input, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyPhone(phoneNumber: string, otpCode: string) { const result = await request<AuthResult & { userId: string }>("/auth/register/verify-phone", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); setAccessToken(result.accessToken); return result; },
  async forgot(phoneNumber: string, captchaToken: string, channel?: OtpChannel) { return request<OtpQueuedResult>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ phoneNumber, ...(channel ? { channel } : {}) }) }, captchaToken); },
  async verifyForgot(phoneNumber: string, otpCode: string) { return request<{ resetToken: string }>("/auth/password/forgot/verify-otp", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  /**
   * Resetting revokes every session the account had and returns a fresh one
   * for this device, so the user lands signed in here and signed out
   * everywhere else.
   */
  async reset(resetToken: string, newPassword: string) { const result = await request<{ success: boolean; signedOut?: true } & Partial<AuthResult>>("/auth/password/reset", { method: "POST", body: JSON.stringify({ resetToken, newPassword }) }); if (result.accessToken) setAccessToken(result.accessToken); return result; },
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
      setAccessToken(result.accessToken);
    } else {
      setAccessToken(null);
    }
    return result;
  },
  /**
   * Sign out of **every** account this browser holds (`F-0211`).
   *
   * The deliberate one, and never the same button as `logout()` — see
   * `SignOutEverywhere`, which asks first.
   */
  async logoutAll() { const result = await request<{ success: boolean }>("/auth/logout/all", { method: "POST", body: JSON.stringify({}) }); setAccessToken(null); return result; },
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
   *
   * `state: "needsPassword"` (SA-1-e): an account the messenger alone does not
   * sign in — the holder of `*` among them. Called again with its `password`,
   * the signature and the password are both factors.
   */
  async webAppSession(platform: "telegram" | "bale", initData: string, password?: string) {
    // Raw, like `/auth/refresh`: it *is* the session every held call waits for.
    const result = await rawRequest<{ state: "authenticated" | "needsContact" | "needsPassword" } & Partial<AuthResult>>(
      "/auth/bots/webapp/session",
      { method: "POST", body: JSON.stringify({ platform, initData, ...(password === undefined ? {} : { password }) }) },
    );
    if (result.accessToken) setAccessToken(result.accessToken);
    return result;
  },
  // Server-verified slide challenge (F-0201) — see docs/interfaces/auth-api/contract.md
  async captchaChallenge() { return request<CaptchaChallenge>("/auth/captcha/challenge", { method: "POST", body: JSON.stringify({}) }); },
  async captchaVerify(challengeId: string) { return request<CaptchaPass>("/auth/captcha/verify", { method: "POST", body: JSON.stringify({ challengeId }) }); },
};
