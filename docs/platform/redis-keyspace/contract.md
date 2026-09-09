---
id: redis-keyspace
layer: platform
status: active
version: 4
updated: 2026-09-09
---

# Contract — redis-keyspace

See ADR-0005. This unit is a convention + a key catalogue, not a service.

## TL;DR

Every Redis key any TXNet service touches is prefixed
`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:` (default `txnet:auth:v3:`).
Two versions have been abandoned, both times because the same six key names
were re-shaped: `v1` on 2026-09-08 when phone numbers became E.164 and the old
spelling became unreachable from the new one (ADR-0018), and `v2` on
2026-09-09 when those names gained a tenant segment (ADR-0023).
Node applies it via ioredis `keyPrefix`; Go assembles it in
`auth-handler/internal/config/config.go` (`buildRedisKeyPrefix`). Bump
`REDIS_KEYSPACE_VERSION` to abandon the entire keyspace at once (old keys
expire on their own). Key **names** are built only in
`txnet-backend/.../redis/redis.keys.ts`; nothing else hand-writes a key string.

## Prefix rule

`namespace` has any trailing `:` stripped, then `":" + version + ":"` is
appended. The two implementations (TS `redis.service.ts`, Go `config.go`) must
stay byte-identical — each carries a comment pointing at the other.

## Key catalogue (names are *after* the prefix)

`<phone>` is always the E.164 form (`+989123456789`, ADR-0018) — the same
string the database stores, so a key and a row can never disagree about which
number they mean.

`<tenantId>` is the tenant the request resolved to. It appears on the keys
built from a phone number, and on `botlink:chat:*`, whose chat id has the same
problem for the opposite reason (F-066-l): a phone number identifies a person
**within** a tenant and not across the platform (ADR-0023), while a chat id is
issued by the messenger and is therefore identical in every reseller's bot.
Without the segment two
resellers selling to the same person share one OTP slot, and identity
invariant #10 — one active code per (phone, purpose) — enforces itself across
the tenancy boundary, evicting one reseller's code when the other issues
theirs. It is the tenant **id**, never the slug, so renaming a reseller does
not lose the code it just issued.

The builders read it from the ambient scope rather than taking it as an
argument (ADR-0024), so a call site written later cannot forget to scope one.
A builder called with no tenant in scope **throws** `TenantContextMissing`
instead of returning an unscoped key.

`<integrationId>` is the `automation.BotIntegration` the update arrived through
(F-320). A chat id is issued by the messenger, not by the bot, so the same
person writing to two resellers' Telegram bots is the same `<chatId>` in both:
on `bot:*` keys the integration, not the platform, is what keeps two tenants
apart.

| Key | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `session:<sessionId>` | string (JSON `{userId,revoked}`) | session lifetime (default 30d; 30m for impersonation) | auth-service `SessionStore.register` | auth-service `AuthGuard`, auth-handler `/validate` |
| `user:<userId>:sessions` | set of sessionIds | = session lifetime | auth-service `SessionStore` | auth-service (bulk revoke) |
| `otp:code:<tenantId>:<purpose>:<phone>` | string (JSON `{codeHash,attemptCount}`) | 300s | auth-service `OtpStore.save` | auth-service verify Lua script |
| `otp:lock:<tenantId>:<purpose>:<phone>` | string | 2s | `OtpStore.acquireLock` (`SET NX`) | — |
| `otp:cooldown:<tenantId>:<purpose>:<phone>` | string | 60s | `OtpStore.startCooldown` | `OtpStore.isCoolingDown` |
| `ratelimit:<bucket>` | counter | window seconds (per call site) | `RateLimiter.hit` (`INCR` + `EXPIRE` on first hit, Lua) | same |
| `register:pending:<tenantId>:<phone>` | string (JSON profile + password hash) | 600s | auth-service `RegisterService.register` | auth-service `RegisterService.verifyPhone` |
| `bot:nav:<platform>:<integrationId>:<chatId>` | string (JSON `NavState`: flow, step, collected fields, last view) | `BOT_NAV_TTL_SEC` (1800s) | bot-service `ConversationStore.save` | bot-service `ConversationRouter` |
| `bot:session:<platform>:<integrationId>:<chatId>` | string (JSON `{refreshToken,signedInAt}`) | `BOT_SESSION_TTL_SEC` (30d, idle — pushed out on every read) | bot-service `BotSessionStore.save` | bot-service (menu, `/logout`) |
| `bot:lang:<platform>:<integrationId>:<chatId>` | string (a language code) | `BOT_LANG_TTL_SEC` (180d, idle) | bot-service `ChatLanguage.choose` | bot-service `ChatLanguage.resolve` |
| `botlink:token:<token>` | string (JSON pending link: platform, phone, purpose, lang, state, otpSent) | `BOT_LINK_TOKEN_TTL_SEC` (900s) | auth-service `BotLinkStore.save/update` | the bot webhook + the client's status poll |
| `botlink:phone:<tenantId>:<platform>:<phone>` | string (the live token) | = above | `BotLinkStore.save` | `BotLinkStore.byPhone` — makes a repeated link request idempotent |
| `botlink:chat:<tenantId>:<platform>:<chatId>` | string (the token this chat is answering) | = above | `BotLinkStore.bindChat` on `/start <token>` | `BotLinkStore.byChat` when the contact arrives — the contact update carries no token of its own. Tenant-scoped since F-066-l: the chat id is the messenger's, so the same person is the same id in every reseller's bot and the second `/start` used to overwrite the first's pointer. The **tenant**, not the bot, is the segment — catalog 10.5 links a person per tenant, so two `/start`s in one reseller's bots are one conversation |
| `captcha:challenge:<challengeId>` | string (issue timestamp, ms) | 60s | auth-service `CaptchaService.issueChallenge` | auth-service `CaptchaService.verifyChallenge` (deletes on first check — single-use) |
| `captcha:verified:<token>` | string (`"1"`) | 120s | auth-service `CaptchaService.verifyChallenge` | auth-service `CaptchaService.consumePass` (deletes on first check — single-use) |
| `tenant:host:<normalizedHost>` | string (JSON `{id,slug}`, or `-` for *no tenant*) | 600s resolved / 60s miss — a **backstop**, not the mechanism | auth-service `TenantCacheService.byHost` | auth-service `TenantResolverService`; deleted by `invalidateDomain` on every domain create/verify/switchover/delete (ADR-0025) |
| `tenant:id:<tenantId>` | string (JSON `{id,slug}`, or `-` for *no tenant*) | = above | auth-service `TenantCacheService.byId` | auth-service `TenantResolverService`; deleted by `invalidateTenant` |
| `fx:rate:<currencyCode>` | string | (currency unit — planned) | (currency service — not built) | (currency conversion) |

## Rules

- A missing `session:<id>` marker means **revoked/expired -> deny**, never
  "unknown -> allow".
- Add a new key only through `redis.keys.ts` (+ a matching const in the Go
  service if it reads it), and record it in the table above.
- **A key built from a phone number carries `<tenantId>`.** The segment comes
  from `TenantContext.current()`, never from a parameter, and its absence is an
  error rather than an unscoped key — the same rule `withTenant` applies to a
  query (`tenant-context/contract.md` rule 3), for the same reason: the wrong
  answer here is two tenants sharing one slot.
- **A session key stays tenant-free.** `auth-handler` builds `session:<id>` in
  Go and has no tenant of its own; a segment here would make every gateway
  lookup miss, and a miss is read as *revoked*. Anything the Go side reads is
  outside this rule by construction.
- Never store money or anything that must survive a keyspace-version bump.
- Re-shaping a key orphans every entry already written under the old one. There
  is no migration and none is wanted: these keys are all TTL'd state, so the
  cost is paid once, in full, at deploy. For `bot:*` (2026-09-09) that read as
  every chat signed out and every half-typed conversation restarted.
- An *incomplete* bot link lives here and nowhere else; only a link the
  messenger has actually vouched for becomes a Postgres row
  (`identity.linked_bot_account`). A keyspace bump therefore cancels pending
  links — the user re-requests the code and gets a fresh deep link.

## Guarantees

- Counter keys always get their TTL atomically on the first increment (Lua), so
  a crash between `INCR` and `EXPIRE` cannot leak a permanent key.
- OTP verify (`peekForVerification`) is atomic via Lua: read + increment under
  `KEEPTTL` + self-destruct after 5 attempts.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| hand-written key strings outside `redis.keys.ts` | 2026-09-04 | — | `RedisKeys.*` builders |
