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

  /**
   * `GET /auth/me` (F-097), per caller. A read of the caller's own row, but the
   * one every panel screen asks on load, so the budget is a client in a loop
   * rather than a person.
   */
  ME: 'me',

  ACCOUNTS_SWITCH: 'accounts:switch',
  ACCOUNTS_REMOVE: 'accounts:remove',

  /**
   * The top-up page's read routes in `billing-service` (F-092-r), per user. A
   * quote at an automatic-fee gateway is one call to the bank, so this budget
   * is also what stands between a user and the merchant's own limit there.
   */
  DEPOSIT_GATEWAYS: 'deposit:gateways',
  DEPOSIT_QUOTE: 'deposit:quote',

  /**
   * Starting a top-up in `billing-service` (F-092-i), per user. Not a read: each
   * call holds coupons, writes a `payment_transaction` and mints an authority at
   * the bank, and every abandoned one sits pending until the expiry job clears
   * it. Its budget is therefore far below the quote's — a user picks a gateway
   * once and pays, and anything that looks like a hundred of these in a quarter
   * of an hour is a stuck client or somebody burning coupon capacity.
   */
  DEPOSIT_START: 'deposit:start',

  /**
   * Settling a top-up in `billing-service` (F-092-j), per **authority** — the
   * one bucket on this list whose subject is not a caller, because the caller
   * is a bank redirecting a browser and carries no identity at all. One
   * authority is one payment, so the budget is how many times a single payment
   * may be presented for settlement in a window: a user reloading the result
   * page costs one each time, and anything beyond that is a replay of a
   * redirect that has already been answered.
   */
  DEPOSIT_CALLBACK: 'deposit:callback',

  /**
   * The financial page's two read routes in `billing-service` (F-092-n), per
   * user. Cheaper per call than a quote — neither leaves the database — but the
   * page refetches on every filter change, so the budget is the panel's own
   * typing speed rather than a bank's limit.
   */
  WALLET_HISTORY: 'wallet:history',
  WALLET_PAYMENTS: 'wallet:payments',

  /**
   * Redeeming a gift code in `billing-service` (F-092-m), per user. The one
   * budget on this list that is a security control rather than a cost control:
   * a gift code is a bearer secret worth money, and the route is the only thing
   * that says whether one exists. Its limit is set far below the read routes'
   * for that reason, and lowering it further costs a user nothing — nobody
   * types twenty gift codes in a quarter of an hour.
   */
  GIFT_REDEEM: 'gift:redeem',

  /**
   * The platform owner's settlement surface in `billing-service` (F-096-e),
   * per operator. Two buckets rather than one because the surface is read far
   * more often than it is written — an operator refreshes what is owed while
   * making a transfer, and grants a gateway a handful of times ever.
   *
   * Neither budget is a security control: the door is the `platform_owner`
   * check and the permission, and an operator who reaches these routes at all
   * is already the one person allowed to. They are here because
   * `request/rate-limit-coverage.spec.ts` admits no unlimited route, and
   * because a runaway admin UI polling `owed` is a cost like any other.
   */
  SETTLEMENT_ADMIN_READ: 'settlement:admin:read',
  SETTLEMENT_ADMIN_WRITE: 'settlement:admin:write',

  /**
   * Gateway management in `billing-service` (F-102-c), per user. Two buckets for
   * the settlement surface's reason: the list is read on every visit, a gateway
   * is created or changed a handful of times ever. Each write also costs a call
   * to `auth-service`'s vault seam, which the write budget bounds.
   */
  GATEWAY_ADMIN_READ: 'gateway:admin:read',
  GATEWAY_ADMIN_WRITE: 'gateway:admin:write',

  /**
   * Manual payment confirmation in `billing-service` (F-092-z), per user. The
   * list is polled by a screen; an inquire or a confirm is a call to a bank.
   */
  PAYMENT_MANUAL_READ: 'payment:manual:read',
  PAYMENT_MANUAL_WRITE: 'payment:manual:write',
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
