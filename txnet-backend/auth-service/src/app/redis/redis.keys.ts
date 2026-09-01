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
} as const;

/** Canonical TTLs (seconds). Kept next to the keys, not scattered in services. */
export const RedisTtl = {
  otpCode: 300,
  otpLock: 2,
  otpCooldown: 60,
  loginFailureWindow: 900,
} as const;
