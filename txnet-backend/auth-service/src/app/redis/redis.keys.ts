import { TenantContext } from '../tenant-context/tenant-context';

/**
 * Every Redis key this service uses is built here — nothing else in the
 * codebase should hand-write a key string. On top of these, ioredis prepends
 * `RedisService.keyPrefix` (`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`),
 * so the on-the-wire key for `session(x)` is e.g. `txnet:auth:v3:session:x`.
 */

/**
 * The tenant segment of a key that is derived from a phone number (ADR-0023).
 *
 * A phone number identifies a person **within a tenant**, so a key built from
 * one is meaningless without saying whose namespace it belongs to: two
 * resellers selling to the same person would otherwise share every `otp:*`,
 * `register:pending:*` and `botlink:*` entry, and identity invariant #10 — one
 * active code per (phone, purpose) — would enforce itself across the tenancy
 * boundary, evicting one reseller's code when the other issued theirs.
 *
 * Read from the ambient context rather than taken as a parameter (ADR-0024):
 * the builder cannot be called without a tenant, so a call site written later
 * cannot forget to scope one. It **throws** when there is no scope, for the
 * same reason `withTenant` does — an unscoped key is a cross-tenant collision,
 * and failing loudly is the only safe default (`tenant-context/contract.md`
 * rule 3).
 *
 * The tenant **id**, not the slug: a slug is a display name and can be
 * changed, and a renamed reseller must not lose the code it just issued.
 */
const tenantSegment = (what: string): string => TenantContext.current(what).id;

export const RedisKeys = {
  /** Marker that a session is still alive; checked on every authenticated request. */
  session: (sessionId: string) => `session:${sessionId}`,
  /** SET of a user's live session ids, so they can all be dropped without a scan. */
  userSessions: (userId: string) => `user:${userId}:sessions`,

  /** Hashed OTP code + attempt counter for one (tenant, purpose, phone). */
  otpCode: (purpose: string, phone: string) =>
    `otp:code:${tenantSegment('an OTP code')}:${purpose}:${phone}`,
  /** Short idempotency lock held while an OTP is being issued. */
  otpLock: (purpose: string, phone: string) =>
    `otp:lock:${tenantSegment('an OTP lock')}:${purpose}:${phone}`,
  /** Per-(tenant, purpose, phone) cooldown between two OTP requests. */
  otpCooldown: (purpose: string, phone: string) =>
    `otp:cooldown:${tenantSegment('an OTP cooldown')}:${purpose}:${phone}`,

  /**
   * Fixed-window rate-limit counter for an arbitrary bucket (F-1206, catalog
   * 20.2 layer 6).
   *
   * The bucket string is the *route's*, and every route builds it from
   * something the platform does not allocate: an IP, a messenger chat id, a
   * username, a phone number. Each of those is the same value at two
   * resellers' front doors, so without the segment one tenant's traffic spends
   * another's budget — and `login-failures:<identity>` is worse than noisy: a
   * reseller's `admin` is locked out because a *different* reseller's `admin`
   * is being guessed at, which is a denial of service one tenant can aim at
   * another for the price of ten bad passwords.
   *
   * The segment is applied here rather than inside `rateLimitSubject()`
   * because two captcha routes and that login-failure bucket never go through
   * the subject helper. A control that only holds for the call sites that
   * remembered it is the shape of leak ADR-0024 exists to remove.
   *
   * **Unlike the phone-derived keys, this one does not throw without a scope.**
   * A request to a host matching no `tenant_domain` row is exactly what a
   * flood looks like, and it must stay countable while `TenantGuard` answers
   * it a 404 — throwing would turn that into a 500 and hand an attacker an
   * uncounted door. `none` is a literal no tenant id can equal, so the
   * unresolved bucket is unreachable from inside a tenant.
   */
  rateLimit: (bucket: string) =>
    `ratelimit:${TenantContext.currentOrNull()?.id ?? 'none'}:${bucket}`,

  /**
   * Pending registration payload (hashed password + profile fields) for a
   * phone number that has not completed OTP verification yet. The `user`
   * row is only created once this is consumed by verify-phone — see
   * identity/invariants.md #11.
   */
  registerPending: (phone: string) =>
    `register:pending:${tenantSegment('a pending registration')}:${phone}`,

  /**
   * A pending bot link: the deep-link token handed to the client, holding the
   * platform, the phone number it was asked for, what to do once the link
   * succeeds, and the current state. Read by the bot webhook and by the
   * client's status poll.
   */
  botLinkToken: (token: string) => `botlink:token:${token}`,
  /**
   * The still-live link token for one (tenant, platform, phone), so re-asking
   * for the same link inside the TTL hands back the same deep link instead of
   * orphaning the previous one.
   */
  botLinkPhone: (platform: string, phone: string) =>
    `botlink:phone:${tenantSegment('a pending bot link')}:${platform}:${phone}`,
  /**
   * Which link token a chat is currently answering. Written when the user
   * sends `/start <token>`, read when their contact arrives in the next
   * message — the contact update carries no token of its own.
   *
   * Tenant-scoped like its two neighbours, though for the opposite reason
   * (F-066-l): a chat id is issued by the messenger, not by us, so the same
   * person answering two resellers' bots presents the *same* id to both and
   * the second `/start` used to overwrite the first's pointer. The tenant, not
   * the bot, is the segment — catalog 10.5 links a person at the tenant level,
   * so their two `/start`s in one reseller's sales and support bots are one
   * conversation and the later one legitimately wins.
   */
  botLinkChat: (platform: string, chatId: string) =>
    `botlink:chat:${tenantSegment('a bot link pointer')}:${platform}:${chatId}`,

  /**
   * A chat that has proven, by shared contact, that it owns this phone number
   * — but has no `user` row to attach to yet (registration is still pending).
   * `verify-phone` promotes it into a `linked_bot_account` at the moment the
   * user is created; until then it is what lets the bot deliver the
   * registration code at all.
   */
  botLinkProvenChat: (platform: string, phone: string) =>
    `botlink:proven:${tenantSegment('a proven bot chat')}:${platform}:${phone}`,

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

  /**
   * Which tenant a normalized host resolves to, or a marker that it resolves
   * to none. Shared rather than in-process because it is invalidated
   * *explicitly* — creating, verifying, switching or deleting a
   * `tenant_domain` row deletes this key, and a per-replica cache would leave
   * every other replica serving the old mapping until its TTL ran out
   * (ADR-0025). A stale mapping after a domain switch is a cross-tenant leak.
   */
  tenantByHost: (host: string) => `tenant:host:${host}`,
  /**
   * Which tenant a claimed tenant id proves to, or a marker that it proves to
   * none. Same lifetime rules as `tenantByHost`: a deleted tenant must stop
   * answering a still-signed token's claim without waiting for a TTL.
   */
  tenantById: (tenantId: string) => `tenant:id:${tenantId}`,
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
  /**
   * Backstop lifetime of a resolved host / tenant id, **not** the mechanism:
   * invalidation is explicit (ADR-0025), and this only bounds how long a
   * missed invalidation can serve the wrong tenant. Longer than the 60s
   * in-process TTL it replaces, because the TTL is no longer what makes a
   * newly verified domain work.
   */
  tenantResolution: 600,
  /**
   * Backstop lifetime of a *negative* answer — a host no row matches, or a
   * claimed tenant id that does not exist. Deliberately much shorter: an
   * unknown host is what a stranger sends, so this bounds how many keys a
   * flood of invented hostnames can hold at once, and a host that becomes
   * known is invalidated explicitly anyway.
   */
  tenantResolutionMiss: 60,
} as const;
