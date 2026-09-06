---
id: redis-keyspace
layer: platform
status: active
version: 3
updated: 2026-09-06
---

# Contract — redis-keyspace

See ADR-0005. This unit is a convention + a key catalogue, not a service.

## TL;DR

Every Redis key any TXNet service touches is prefixed
`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:` (default `txnet:auth:v1:`).
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

| Key | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `session:<sessionId>` | string (JSON `{userId,revoked}`) | session lifetime (default 30d; 30m for impersonation) | auth-service `SessionStore.register` | auth-service `AuthGuard`, auth-handler `/validate` |
| `user:<userId>:sessions` | set of sessionIds | = session lifetime | auth-service `SessionStore` | auth-service (bulk revoke) |
| `otp:code:<purpose>:<phone>` | string (JSON `{codeHash,attemptCount}`) | 300s | auth-service `OtpStore.save` | auth-service verify Lua script |
| `otp:lock:<purpose>:<phone>` | string | 2s | `OtpStore.acquireLock` (`SET NX`) | — |
| `otp:cooldown:<purpose>:<phone>` | string | 60s | `OtpStore.startCooldown` | `OtpStore.isCoolingDown` |
| `ratelimit:<bucket>` | counter | window seconds (per call site) | `RateLimiter.hit` (`INCR` + `EXPIRE` on first hit, Lua) | same |
| `register:pending:<phone>` | string (JSON profile + password hash) | 600s | auth-service `RegisterService.register` | auth-service `RegisterService.verifyPhone` |
| `bot:nav:<platform>:<chatId>` | string (JSON `NavState`: flow, step, collected fields, last view) | `BOT_NAV_TTL_SEC` (1800s) | bot-service `ConversationStore.save` | bot-service `ConversationRouter` |
| `bot:session:<platform>:<chatId>` | string (JSON `{refreshToken,signedInAt}`) | `BOT_SESSION_TTL_SEC` (30d, idle — pushed out on every read) | bot-service `BotSessionStore.save` | bot-service (menu, `/logout`) |
| `botlink:token:<token>` | string (JSON pending link: platform, phone, purpose, lang, state, otpSent) | `BOT_LINK_TOKEN_TTL_SEC` (900s) | auth-service `BotLinkStore.save/update` | the bot webhook + the client's status poll |
| `botlink:phone:<platform>:<phone>` | string (the live token) | = above | `BotLinkStore.save` | `BotLinkStore.byPhone` — makes a repeated link request idempotent |
| `botlink:chat:<platform>:<chatId>` | string (the token this chat is answering) | = above | `BotLinkStore.bindChat` on `/start <token>` | `BotLinkStore.byChat` when the contact arrives — the contact update carries no token of its own |
| `captcha:challenge:<challengeId>` | string (issue timestamp, ms) | 60s | auth-service `CaptchaService.issueChallenge` | auth-service `CaptchaService.verifyChallenge` (deletes on first check — single-use) |
| `captcha:verified:<token>` | string (`"1"`) | 120s | auth-service `CaptchaService.verifyChallenge` | auth-service `CaptchaService.consumePass` (deletes on first check — single-use) |
| `fx:rate:<currencyCode>` | string | (currency unit — planned) | (currency service — not built) | (currency conversion) |

## Rules

- A missing `session:<id>` marker means **revoked/expired -> deny**, never
  "unknown -> allow".
- Add a new key only through `redis.keys.ts` (+ a matching const in the Go
  service if it reads it), and record it in the table above.
- Never store money or anything that must survive a keyspace-version bump.
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
