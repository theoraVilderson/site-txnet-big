import { REFRESH_TOKEN_LIFETIME_SEC } from '../http/cookies';

/**
 * Every Redis lifetime this platform sets, in one place (F-078, ADR-0036).
 *
 * **Why a file of its own, beside `keys.ts`.** A TTL is not a detail of the key
 * it sits on: several of them are *relationships*, and a relationship cannot be
 * checked when the two numbers live in different files. `registerPending` must
 * outlast `otpCode` or a valid code arrives with nothing left to register;
 * `otpChannel` must not outlast `otpDelivery` or a socket is held open for an
 * event that can never come. Those are invariants, and `ttl.spec.ts` asserts
 * them.
 *
 * **What F-078 found scattered.** `LOGIN_FAILURE_WINDOW_SEC = 900` sat in
 * `auth.service.ts` duplicating a `RedisTtl.loginFailureWindow` that was
 * imported *nowhere* — the catalogue entry existed and only its own snapshot
 * referenced it. The impersonated-session lifetime was a private const in
 * `impersonation.service.ts` though invariant #7 is about it. `bot-service`'s
 * env schema re-spelled the bot session and nav lifetimes as zod defaults,
 * while `BOT_LANG_TTL_SEC` three lines away correctly deferred to the
 * catalogue — the same file disagreeing with itself about where a lifetime
 * lives.
 *
 * **Rate-limit window values stay at their call sites**, and that is
 * deliberate: `auth-api/contract.rate-limits.md` sanctions it, because a
 * window is part of a route's published limit rather than a property of the
 * keyspace.
 */
export const RedisTtl = {
  otpCode: 300,
  otpLock: 2,
  otpCooldown: 60,
  /** == otpCode: a delivery status must not outlive the code it describes. */
  otpDelivery: 300,
  /**
   * == otpDelivery: the channel that carries a delivery's result must not
   * outlive the result, and a subscription to it after that point would be a
   * socket held open for an event that can never come.
   */
  otpChannel: 300,
  loginFailureWindow: 900,
  /** >= otpCode so a still-valid OTP never outlives the data it verifies. */
  registerPending: 600,
  /** Window the client has to complete the slide after a challenge is issued. */
  captchaChallenge: 60,
  /** How long a completed captcha pass stays usable before it must be redone. */
  captchaVerified: 120,
  /**
   * Fallback lifetime of a pending bot link and of the chat->token pointer.
   * `BOT_LINK_TOKEN_TTL_SEC` overrides it; kept here so the key catalogue still
   * states a TTL for every key.
   */
  botLink: 900,
  /**
   * Backstop lifetime of a resolved host / tenant id, **not** the mechanism:
   * invalidation is explicit (ADR-0025), and this only bounds how long a missed
   * invalidation can serve the wrong tenant.
   */
  tenantResolution: 600,
  /**
   * Backstop lifetime of a *negative* answer — a host no row matches, or a
   * claimed tenant id that does not exist. Deliberately much shorter: an
   * unknown host is what a stranger sends, so this bounds how many keys a flood
   * of invented hostnames can hold at once, and a host that becomes known is
   * invalidated explicitly anyway.
   */
  tenantResolutionMiss: 60,

  botNav: 30 * 60,
  botSession: 30 * 24 * 3600,
  /** Long: this is a preference, not a session. It is re-armed on every use. */
  botLang: 180 * 24 * 3600,

  /**
   * An impersonated session is short-lived by design (`identity/invariants.md`
   * #7). It was a private const in `impersonation.service.ts`, which put a
   * number an invariant is written about somewhere no catalogue could see.
   */
  impersonation: 30 * 60,

  /**
   * The refresh token's lifetime, and therefore the refresh cookie's `Max-Age`.
   *
   * Re-exported rather than re-typed: the declaration lives with the cookie
   * (`shared-core/src/lib/http/cookies.ts`, F-073) because the cookie and the
   * token are one lifetime, and a second number here would be exactly the
   * split this file exists to close.
   */
  refreshToken: REFRESH_TOKEN_LIFETIME_SEC,
} as const;
