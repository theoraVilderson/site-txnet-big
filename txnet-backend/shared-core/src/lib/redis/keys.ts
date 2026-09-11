import { REALTIME_FANOUT_PREFIX } from '../realtime/fanout';

/**
 * Every Redis key name this platform writes, in one place (ADR-0036, C-03).
 *
 * **Why one file for four services.** There were four `redis.keys.ts`, one per
 * Nx application, and three families overlapped: `session:` was built in
 * `auth-service` and `gateway-service`, `otp:channel:` in the same two, and the
 * realtime fan-out name in three. `auth-handler` had no builder at all and
 * concatenated `keyPrefix + "session:" + sessionID` by hand — C-03 has required
 * a Go builder since it was written, and one had never existed.
 *
 * Two services spelling one key is not a tidiness problem. A key that changes
 * shape does not fail: it silently stops finding data that is already there.
 * `session:` reading differently in the gateway than in the service that wrote
 * it means every request is answered "session revoked", which is a total outage
 * wearing the costume of a mass logout.
 *
 * **The split into two exports is about ambient scope, not about tidiness.**
 * The tenant-derived families read the request's tenant out of an ambient
 * context (ADR-0024) so that a call site written later cannot forget to scope
 * one. That context exists only in `auth-service`: `worker-service` handles
 * broker messages with no request, and `gateway-service` and `auth-handler`
 * hold no tenant of their own at all. Handing those processes a builder that
 * throws would be a footgun, and moving the context here to avoid that would
 * drag a request-scoped mechanism into three processes that have no requests.
 *
 * So {@link UnscopedRedisKeys} is what every process can build, and
 * {@link createScopedRedisKeys} is the rest, constructed with the scope
 * `auth-service` owns. The policy stays where the context is; only the strings
 * moved.
 */

/**
 * How a scoped key finds the tenant it belongs to.
 *
 * Two methods rather than one, because the two families genuinely differ in
 * what an absent tenant means, and collapsing them would break one of them:
 *
 * - {@link tenant} is for a key derived from a phone number. It **throws** when
 *   there is no scope — an unscoped key is a cross-tenant collision, and
 *   failing loudly is the only safe default.
 * - {@link tenantOrNone} is for a rate-limit bucket. It must **never** throw: a
 *   request to a host matching no tenant is exactly what a flood looks like and
 *   has to stay countable while the guard answers it a 404.
 */
export interface RedisKeyScope {
  /** The tenant id, or a throw. `what` names the key, for the error message. */
  tenant(what: string): string;
  /** The tenant id, or a literal no tenant id can equal. */
  tenantOrNone(): string;
}

/**
 * The key families any process can build, because none of them needs to know
 * whose request it is.
 */
export const UnscopedRedisKeys = {
  /** Marker that a session is still alive; checked on every authenticated request. */
  session: (sessionId: string) => `session:${sessionId}`,
  /** SET of a user's live session ids, so they can all be dropped without a scan. */
  userSessions: (userId: string) => `user:${userId}:sessions`,

  /**
   * The token that authorizes a subscription to one OTP delivery's realtime
   * channel (F-067-j). Written by `auth-service` when the 202 is answered, read
   * by `gateway-service` once, at subscribe time, and left to expire.
   *
   * **Deliberately not tenant-segmented**, and it is the same exception
   * `session` takes rather than a new one: the reader is a process with no
   * tenant of its own, so a segment here would produce a key it can never
   * build — and a miss reads as "never minted", which refuses every
   * subscription with no error on either side.
   *
   * The id alone is 128 random bits, so the segment buys nothing here that it
   * buys for a phone-derived key: there is no collision between resellers to
   * prevent when neither can guess the other's id.
   */
  otpChannel: (channelId: string) => `otp:channel:${channelId}`,

  /**
   * The pub/sub channel one realtime channel's events ride (F-067-i).
   *
   * Not a key — a channel name — which is why the caller applies the keyspace
   * prefix by hand. ioredis prepends the prefix to *key* arguments, and
   * `PUBLISH`/`SUBSCRIBE` take a channel, which Redis does not count as a key,
   * so the prefix every other call here gets for free is silently absent. The
   * publisher (`worker-service`, `auth-service`) and the subscriber
   * (`gateway-service`) build it from this one function because a disagreement
   * between them publishes successfully into a channel nobody hears.
   */
  realtimeFanout: (channel: string) => `${REALTIME_FANOUT_PREFIX}${channel}`,

  /**
   * The same rate-limit bucket counted once for the whole platform, with no
   * tenant in it (F-066-s).
   *
   * `rateLimit` keys on a tenant the caller chooses by picking a hostname, so N
   * tenants is N budgets for one IP — the cost F-066-o accepted and left
   * written down. This counter is what that cost is paid out of.
   *
   * `platform` sits where a tenant id sits, alongside `none`, and no tenant id
   * can equal either — the segment is a literal, so neither bucket is reachable
   * from inside a tenant.
   *
   * **Only caller-derived buckets belong here.** `login-failures:<identity>` is
   * keyed on the account being guessed at, not on who is guessing, so a
   * platform-wide counter over it would lock every reseller's `admin` out
   * because one reseller's was attacked.
   */
  rateLimitPlatform: (bucket: string) => `ratelimit:platform:${bucket}`,

  /**
   * A pending bot link: the deep-link token handed to the client, holding the
   * platform, the phone number it was asked for, what to do once the link
   * succeeds, and the current state. Read by the bot webhook and by the
   * client's status poll.
   */
  botLinkToken: (token: string) => `botlink:token:${token}`,

  /**
   * A bot-challenge that has been issued but not yet completed. Value is the
   * issue timestamp (ms), used to reject a slide completed faster than a human
   * could plausibly drag it. Deleted on first verify attempt (single-use) — see
   * `auth-api/contract.md`.
   */
  captchaChallenge: (challengeId: string) => `captcha:challenge:${challengeId}`,
  /**
   * A completed, still-usable captcha pass. Single-use: `CaptchaGuard` deletes
   * it on the first request that spends it.
   */
  captchaVerified: (token: string) => `captcha:verified:${token}`,

  /**
   * Which tenant a normalized host resolves to, or a marker that it resolves to
   * none. Shared rather than in-process because it is invalidated *explicitly*
   * — creating, verifying, switching or deleting a `tenant_domain` row deletes
   * this key, and a per-replica cache would leave every other replica serving
   * the old mapping until its TTL ran out (ADR-0025). A stale mapping after a
   * domain switch is a cross-tenant leak.
   */
  tenantByHost: (host: string) => `tenant:host:${host}`,
  /**
   * Which tenant a claimed tenant id proves to, or a marker that it proves to
   * none. Same lifetime rules as `tenantByHost`: a deleted tenant must stop
   * answering a still-signed token's claim without waiting for a TTL.
   */
  tenantById: (tenantId: string) => `tenant:id:${tenantId}`,

  /**
   * The leases one tenant's background runs currently hold, across every
   * `worker-service` replica (F-067-e, catalog 20.2 layer 4).
   *
   * A **sorted set** of lease tokens scored by the moment each expires, not a
   * counter. `INCR`/`DECR` is the obvious shape and it is the wrong one: a
   * replica killed mid-run never decrements, so the tenant's budget shrinks
   * permanently and there is no event that would ever restore it — the cap
   * degrades into a lockout, quietly, and only for the tenant that had the bad
   * luck. A lease that expires recovers itself.
   *
   * The tenant id comes from the tick message, not from an ambient scope, which
   * is why this key is here and not in {@link createScopedRedisKeys}: there is
   * no request in `worker-service` to have resolved a tenant, and the message
   * is the only thing that knows whose work this is.
   */
  tenantRuns: (tenantId: string) => `automation:tenant-runs:${tenantId}`,
} as const;

/**
 * Every chat key names its integration, not just its platform (F-320).
 *
 * A chat id is issued by the messenger, not by the bot: the same person talking
 * to two tenants' Telegram bots is the same `chatId` on both. Keyed by platform
 * alone, one reseller's customer would resume the other reseller's conversation
 * and — for `bot:session:` — hold the other reseller's refresh token. The
 * integration id is the one door the update came through (ADR-0009), so it is
 * what separates them. The platform stays ahead of it because it costs nothing
 * and keeps the keyspace scannable per messenger.
 *
 * Typed structurally rather than against `BotIntegration` so this library does
 * not depend on `messenger`; `bot-service` passes the real type straight in.
 */
export interface BotKeyIntegration {
  readonly platform: string;
  readonly id: string;
}

const chatScope = (integration: BotKeyIntegration, chatId: string) =>
  `${integration.platform}:${integration.id}:${chatId}`;

/** The bot chat families. No ambient scope: the integration is the scope. */
export const BotRedisKeys = {
  /**
   * Navigation state: which screen the chat is on, what it has typed so far,
   * where "back" goes. Losing it costs the user one tap, which is exactly why
   * it lives here and a commitment does not (ADR-0010).
   */
  botNav: (integration: BotKeyIntegration, chatId: string) =>
    `bot:nav:${chatScope(integration, chatId)}`,
  /**
   * A signed-in chat: the `auth-api` refresh token and who it belongs to. This
   * entry — never the chat id on its own — is what makes a chat authenticated
   * (`bot-app/contract.md`).
   */
  botSession: (integration: BotKeyIntegration, chatId: string) =>
    `bot:session:${chatScope(integration, chatId)}`,
  /**
   * The language this chat asked for, by hand.
   *
   * Deliberately not part of the session or the navigation state: it outlives
   * both. A preference that expires with the conversation that set it is a
   * preference the user has to set again every time, which is worse than not
   * offering the choice.
   *
   * Scoped to the integration like the other two, even though a language is
   * harmless to share: one tenant's bot may serve a language another's does
   * not, so a preference carried across would be a choice the second bot cannot
   * honour and the user never made there.
   */
  botLang: (integration: BotKeyIntegration, chatId: string) =>
    `bot:lang:${chatScope(integration, chatId)}`,
} as const;

/**
 * The families that only mean something inside one tenant (ADR-0023, ADR-0024).
 *
 * A phone number identifies a person **within a tenant**, so a key built from
 * one is meaningless without saying whose namespace it belongs to: two
 * resellers selling to the same person would otherwise share every `otp:*`,
 * `register:pending:*` and `botlink:*` entry, and identity invariant #10 — one
 * active code per (phone, purpose) — would enforce itself across the tenancy
 * boundary, evicting one reseller's code when the other issued theirs.
 *
 * The segment is the tenant **id**, not the slug: a slug is a display name and
 * can be changed, and a renamed reseller must not lose the code it just issued.
 */
export function createScopedRedisKeys(scope: RedisKeyScope) {
  return {
    /** Hashed OTP code + attempt counter for one (tenant, purpose, phone). */
    otpCode: (purpose: string, phone: string) =>
      `otp:code:${scope.tenant('an OTP code')}:${purpose}:${phone}`,
    /** Short idempotency lock held while an OTP is being issued. */
    otpLock: (purpose: string, phone: string) =>
      `otp:lock:${scope.tenant('an OTP lock')}:${purpose}:${phone}`,
    /** Per-(tenant, purpose, phone) cooldown between two OTP requests. */
    otpCooldown: (purpose: string, phone: string) =>
      `otp:cooldown:${scope.tenant('an OTP cooldown')}:${purpose}:${phone}`,

    /**
     * What became of one OTP send (F-067-a): `queued`, then `sent` or `failed`.
     *
     * Keyed on a delivery id the route minted, not on the phone number, because
     * the caller who reads it is unauthenticated — `login` and `register` have
     * no session yet — and a key a stranger could name from a phone number
     * would answer whether that number was just sent a code. The id is random,
     * is handed out exactly once in the 202, and outlives nothing: its TTL is
     * the code's, so a status cannot be read back after the code it describes
     * is already dead.
     *
     * Tenant-segmented like every other phone-derived key even though the id
     * alone is unguessable: two resellers must not be able to collide on one,
     * and the rule is worth more than the exception.
     */
    otpDelivery: (deliveryId: string) =>
      `otp:delivery:${scope.tenant('an OTP delivery status')}:${deliveryId}`,

    /**
     * Fixed-window rate-limit counter for an arbitrary bucket (F-1206, catalog
     * 20.2 layer 6).
     *
     * The bucket string is the *route's*, and every route builds it from
     * something the platform does not allocate: an IP, a messenger chat id, a
     * username, a phone number. Each of those is the same value at two
     * resellers' front doors, so without the segment one tenant's traffic
     * spends another's budget — and `login-failures:<identity>` is worse than
     * noisy: a reseller's `admin` is locked out because a *different*
     * reseller's `admin` is being guessed at, which is a denial of service one
     * tenant can aim at another for the price of ten bad passwords.
     *
     * **Unlike the phone-derived keys, this one does not throw without a
     * scope.** A request to a host matching no `tenant_domain` row is exactly
     * what a flood looks like, and it must stay countable while `TenantGuard`
     * answers it a 404 — throwing would turn that into a 500 and hand an
     * attacker an uncounted door.
     */
    rateLimit: (bucket: string) =>
      `ratelimit:${scope.tenantOrNone()}:${bucket}`,

    /**
     * Pending registration payload (hashed password + profile fields) for a
     * phone number that has not completed OTP verification yet. The `user` row
     * is only created once this is consumed by verify-phone — see
     * `identity/invariants.md` #11.
     */
    registerPending: (phone: string) =>
      `register:pending:${scope.tenant('a pending registration')}:${phone}`,

    /**
     * The still-live link token for one (tenant, platform, phone), so re-asking
     * for the same link inside the TTL hands back the same deep link instead of
     * orphaning the previous one.
     */
    botLinkPhone: (platform: string, phone: string) =>
      `botlink:phone:${scope.tenant('a pending bot link')}:${platform}:${phone}`,
    /**
     * Which link token a chat is currently answering. Written when the user
     * sends `/start <token>`, read when their contact arrives in the next
     * message — the contact update carries no token of its own.
     *
     * Tenant-scoped like its two neighbours, though for the opposite reason
     * (F-066-l): a chat id is issued by the messenger, not by us, so the same
     * person answering two resellers' bots presents the *same* id to both and
     * the second `/start` used to overwrite the first's pointer. The tenant,
     * not the bot, is the segment — catalog 10.5 links a person at the tenant
     * level, so their two `/start`s in one reseller's sales and support bots
     * are one conversation and the later one legitimately wins.
     */
    botLinkChat: (platform: string, chatId: string) =>
      `botlink:chat:${scope.tenant('a bot link pointer')}:${platform}:${chatId}`,

    /**
     * A chat that has proven, by shared contact, that it owns this phone number
     * — but has no `user` row to attach to yet (registration is still pending).
     * `verify-phone` promotes it into a `linked_bot_account` at the moment the
     * user is created; until then it is what lets the bot deliver the
     * registration code at all.
     */
    botLinkProvenChat: (platform: string, phone: string) =>
      `botlink:proven:${scope.tenant('a proven bot chat')}:${platform}:${phone}`,
  } as const;
}
