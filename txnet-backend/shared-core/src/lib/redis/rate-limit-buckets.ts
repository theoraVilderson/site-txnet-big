/**
 * Every rate-limit bucket this platform counts, declared once (F-077,
 * ADR-0036).
 *
 * **What a bucket actually is.** The on-the-wire counter key is
 * `ratelimit:<tenantId>:<bucket>:<subject>`. `RedisKeys.rateLimit()` owns the
 * first half; the `<bucket>` segment was a free-form template literal at all
 * twenty-two `@RateLimit` call sites, with nothing checking it — it is part of
 * a Redis key name and it was the only part with no builder.
 *
 * **Why that mattered more than it looks.** Two call sites that mean to share a
 * budget must spell the bucket identically, and two that mean to be separate
 * must not collide. Both failures are silent. `login-failures:<identity>` was
 * spelled by hand in two places with a comment between them saying they had to
 * stay the same — which is the clearest possible statement that nothing was
 * making them. And several bucket names duplicate real key families
 * (`otp:delivery:`, `bot:session:`, `captcha:challenge:`, `register:`), so a
 * reader scanning the keyspace cannot tell a counter from the thing it counts.
 *
 * **A registry, not a builder.** There is no structure here to build: the
 * bucket is a name. What the registry buys is a compile error on a typo or a
 * duplicate, and one place to read the whole rate-limit surface of the
 * platform — which, before this, could only be assembled by grepping for a
 * decorator.
 */

/**
 * The declared buckets. Frozen and `as const`, so a typo is a type error and a
 * duplicate value is visible in one screen rather than across six controllers.
 *
 * Names are grouped by the surface they protect. The value is the wire segment
 * and must never change casually: changing one resets that limiter, which is
 * harmless for a counter and is still a thing to do deliberately.
 */
export const RateLimitBucket = {
  /** Password login. Shares its budget with nothing. */
  LOGIN_PWD: 'login:pwd',
  LOGIN_OTP_REQUEST: 'login:otp:req',
  LOGIN_OTP_VERIFY: 'login:otp:verify',

  /**
   * Failed password attempts for one identity, which is what locks an account.
   *
   * The one bucket keyed on **who is being guessed at** rather than on who is
   * guessing, which is why it must never be counted platform-wide: a
   * platform-wide counter over it locks every reseller's `admin` out because
   * one reseller's was attacked (F-066-o).
   *
   * Two routes spend it — ordinary login and the password-change check — on
   * purpose: the second is another way to guess a password, so it has to
   * consume the same budget or it becomes the cheaper door.
   */
  LOGIN_FAILURES: 'login-failures',

  REGISTER: 'register',
  REGISTER_VERIFY: 'register:verify',

  PASSWORD_FORGOT: 'pwd:forgot',
  PASSWORD_FORGOT_VERIFY: 'pwd:forgot:verify',

  OTP_DELIVERY_STATUS: 'otp:delivery',
  OTP_CHANNELS: 'otp:channels',

  CAPTCHA_CHALLENGE: 'captcha:challenge',
  CAPTCHA_VERIFY: 'captcha:verify',

  BOT_LINK_RESOLVE: 'bot:link:resolve',
  BOT_LINK_CONTACT: 'bot:link:contact',
  BOT_LINK_STATUS: 'bot:link:status',
  BOT_SESSION: 'bot:session',
  BOT_WEBAPP_SESSION: 'bot:webapp:session',

  ACCOUNTS_ADD_OTP_REQUEST: 'accounts:add:otp:req',
  ACCOUNTS_ADD_OTP_VERIFY: 'accounts:add:otp:verify',
  ACCOUNTS_ADD_PASSWORD: 'accounts:add:pwd',
  ACCOUNTS_LIST: 'accounts:list',
  ACCOUNTS_SWITCH: 'accounts:switch',
  ACCOUNTS_REMOVE: 'accounts:remove',
} as const;

export type RateLimitBucket =
  (typeof RateLimitBucket)[keyof typeof RateLimitBucket];

/**
 * Join a declared bucket to the subject being counted.
 *
 * The separator lives here for the same reason the bucket names do: it is part
 * of a key on the wire, and a call site that used `.` or `/` instead would
 * quietly get its own counter. One line, one place.
 */
export function rateLimitBucketKey(
  bucket: RateLimitBucket,
  subject: string,
): string {
  return `${bucket}:${subject}`;
}
