/**
 * Every Redis key this service uses is built here — nothing else in the
 * codebase should hand-write a key string. On top of these, ioredis prepends
 * `RedisService.keyPrefix` (`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`),
 * so the on-the-wire key for `session(x)` is e.g. `txnet:auth:v1:session:x`.
 */
export const RedisKeys = {
  /** Marker that a session is still alive; checked on every authenticated request. */
  session: (sessionId: string) => `session:${sessionId}`,
  /** SET of a user's live session ids, so they can all be dropped without a scan. */
  userSessions: (userId: string) => `user:${userId}:sessions`,

  /** Hashed OTP code + attempt counter for one (purpose, phone). */
  otpCode: (purpose: string, phone: string) => `otp:code:${purpose}:${phone}`,
  /** Short idempotency lock held while an OTP is being issued. */
  otpLock: (purpose: string, phone: string) => `otp:lock:${purpose}:${phone}`,
  /** Per-(purpose, phone) cooldown between two OTP requests. */
  otpCooldown: (purpose: string, phone: string) =>
    `otp:cooldown:${purpose}:${phone}`,

  /** Fixed-window rate-limit counter for an arbitrary bucket. */
  rateLimit: (bucket: string) => `ratelimit:${bucket}`,

  /**
   * Pending registration payload (hashed password + profile fields) for a
   * phone number that has not completed OTP verification yet. The `user`
   * row is only created once this is consumed by verify-phone — see
   * identity/invariants.md #11.
   */
  registerPending: (phone: string) => `register:pending:${phone}`,

  /**
   * A pending bot link: the deep-link token handed to the client, holding the
   * platform, the phone number it was asked for, what to do once the link
   * succeeds, and the current state. Read by the bot webhook and by the
   * client's status poll.
   */
  botLinkToken: (token: string) => `botlink:token:${token}`,
  /**
   * The still-live link token for one (platform, phone), so re-asking for the
   * same link inside the TTL hands back the same deep link instead of
   * orphaning the previous one.
   */
  botLinkPhone: (platform: string, phone: string) =>
    `botlink:phone:${platform}:${phone}`,
  /**
   * Which link token a chat is currently answering. Written when the user
   * sends `/start <token>`, read when their contact arrives in the next
   * message — the contact update carries no token of its own.
   */
  botLinkChat: (platform: string, chatId: string) =>
    `botlink:chat:${platform}:${chatId}`,

  /**
   * A chat that has proven, by shared contact, that it owns this phone number
   * — but has no `user` row to attach to yet (registration is still pending).
   * `verify-phone` promotes it into a `linked_bot_account` at the moment the
   * user is created; until then it is what lets the bot deliver the
   * registration code at all.
   */
  botLinkProvenChat: (platform: string, phone: string) =>
    `botlink:proven:${platform}:${phone}`,

  /**
   * A bot-challenge that has been issued but not yet completed. Value is the
   * issue timestamp (ms), used to reject a slide completed faster than a
   * human could plausibly drag it. Deleted on first verify attempt
   * (single-use) — see auth-api/contract.md.
   */
  captchaChallenge: (challengeId: string) => `captcha:challenge:${challengeId}`,
  /**
   * A completed, still-usable captcha pass. Single-use: `CaptchaGuard`
   * deletes it on the first request that spends it.
   */
  captchaVerified: (token: string) => `captcha:verified:${token}`,
} as const;

/** Canonical TTLs (seconds). Kept next to the keys, not scattered in services. */
export const RedisTtl = {
  otpCode: 300,
  otpLock: 2,
  otpCooldown: 60,
  loginFailureWindow: 900,
  /** >= otpCode so a still-valid OTP never outlives the data it verifies. */
  registerPending: 600,
  /** Window the client has to complete the slide after a challenge is issued. */
  captchaChallenge: 60,
  /** How long a completed captcha pass stays usable before it must be redone. */
  captchaVerified: 120,
  /**
   * Fallback lifetime of a pending bot link and of the chat->token pointer.
   * `BOT_LINK_TOKEN_TTL_SEC` overrides it; kept here so the key catalogue
   * still states a TTL for every key.
   */
  botLink: 900,
} as const;
