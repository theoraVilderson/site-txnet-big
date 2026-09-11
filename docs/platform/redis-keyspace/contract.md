---
id: redis-keyspace
layer: platform
status: active
version: 5
updated: 2026-09-11
---

# Contract — redis-keyspace

See ADR-0005. This unit is a convention + a key catalogue, not a service.

## TL;DR

Every Redis key any TXNet service touches is prefixed
`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`. The default is
**`txnet:auth:v2:`**, declared once in `contracts/redis/keyspace.json` and held
there by a test in each language (ADR-0036). Bump `REDIS_KEYSPACE_VERSION` to
abandon the entire keyspace at once; old keys expire on their own. Key **names**
are built only through the shared builder; nothing else hand-writes a key string
(C-03).

**One catalogue, four views.** The names live in
`shared-core/src/lib/redis/keys.ts`; each application keeps a shim that
re-exports it, so the ~200 import sites did not move. The shim is where the one
thing that could not move stays: `auth-service` supplies the ambient tenant
scope (ADR-0024), which exists in no other process. `auth-handler` builds the
cross-language families in `internal/cache/keys.go`, held to
`contracts/redis/keyspace.json` by a test on each side.

Before the merge there were four catalogues and three overlapping families —
`session:` in two, `otp:channel:` in two, the realtime fan-out name in three —
with nothing comparing the spellings.

**The version history in this file was aspirational, and F-075 found out why.**
Two bumps are recorded — `v1` abandoned 2026-09-08 when phone numbers became
E.164 and the old spelling became unreachable from the new one (ADR-0018), and
`v2` abandoned 2026-09-09 when those names gained a tenant segment (ADR-0023).
Neither bump ever took effect, because no single value was ever in force: four
`env.validation.ts` files and `config.go` defaulted `v1`, `.env` said `v2`, and
`docker-compose.main.yml` defaulted `v3` across five services. Which keyspace a
container read depended on whether `.env` reached it. Measured on 2026-09-11:
**8 live sessions under `v1`, 7 under `v2`, none under `v3`.**

Unified on `v2` on the user's call, 2026-09-11 (ADR-0036) — the `.env` value, so
the larger surviving half of dev kept its sessions. The `v1` eight were signed
out, which is what a version change is for.

**The unification is safe only where no old-shape key survives under `v2`.** In
dev it is: everything under that prefix was written by today's code, because the
prefix only ever came from `.env` and `.env` has said `v2` throughout. A
deployment whose Redis still holds pre-ADR-0023 keys under `v2` would resurrect
them into collision with current-shape ones — see `open-questions.md`.

Node applies the prefix via ioredis `keyPrefix`; Go assembles it in
`auth-handler/internal/config/config.go` (`buildRedisKeyPrefix`). Both now call
the same declared algorithm.

## Prefix rule

`namespace` has any trailing `:` stripped, then `":" + version + ":"` is
appended. One declaration of that algorithm per language —
`shared-core/src/lib/redis/keyspace.ts` and `config.go`'s
`buildRedisKeyPrefix` — both held to `contracts/redis/keyspace.json` by a test
(ADR-0036). They were previously kept byte-identical by a comment pointing each
at the other, plus a third transcription of the Go function inside a TypeScript
spec; that spec tested that two TypeScript functions agreed and could never
have caught the Go side drifting, so it is gone.

The trailing-colon strip is not tidying. A namespace written with one that only
one language strips puts Go and Node in different keyspaces, and every request
the gateway sees is then answered `session_revoked` while the sessions sit
there under a slightly different name.

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

**Every lifetime in the TTL column is a `RedisTtl` entry**
(`shared-core/src/lib/redis/ttl.ts`), including the ones an env var can widen —
the schema's default *is* the catalogue entry (F-078, C-03). Rate-limit window
values are the documented exception and stay at their call sites, because a
window is part of a route's published limit rather than a property of the
keyspace (`auth-api/contract.rate-limits.md`).

Several of these lifetimes are **relationships** rather than values, and
`ttl.spec.ts` asserts them: a pending registration must outlast the code that
unlocks it, a delivery status must not outlast the code it describes, and a
realtime channel must not outlast the result it carries. None of those fails
loudly — they surface as a valid OTP that verifies nothing, or a socket held
open for an event that can never come.

| Key | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `session:<sessionId>` | string (JSON `{userId,revoked,scopeKey}`) | session lifetime (default 30d; 30m for impersonation) | auth-service `SessionStore.register` | auth-service `AuthGuard` (`SessionStore.read`), auth-handler `/validate` |
| `user:<userId>:sessions` | set of sessionIds | = session lifetime | auth-service `SessionStore` | auth-service (bulk revoke) |
| `otp:code:<tenantId>:<purpose>:<phone>` | string (JSON `{codeHash,attemptCount}`) | 300s | auth-service `OtpStore.save` | auth-service verify Lua script |
| `otp:lock:<tenantId>:<purpose>:<phone>` | string | 2s | `OtpStore.acquireLock` (`SET NX`) | — |
| `otp:cooldown:<tenantId>:<purpose>:<phone>` | string | 60s | `OtpStore.startCooldown` | `OtpStore.isCoolingDown` |
| `ratelimit:<tenantId>:<bucket>` | counter | window seconds (per call site) | `RateLimiter.hit` (`INCR` + `EXPIRE` on first hit, Lua) | same. `<tenantId>` is `none` when the request resolved to no tenant — this is the one tenant-segmented key that does not throw without a scope (F-066-o) |
| `ratelimit:platform:<bucket>` | counter | window seconds (same as the tenant counter beside it) | `RateLimiter.hitPlatform` (`INCR` + `EXPIRE` on first hit, Lua) | same. The same bucket with no tenant in it, so one caller's traffic across every tenant it can name lands in one counter (F-066-s). `platform` is a literal in the tenant-id position, like `none` |
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
| `automation:tenant-runs:<tenantId>` | sorted set (lease token -> expiry ms) | `AUTOMATION_RUN_TIMEOUT_MS` (600s), re-armed on every grant | worker-service `TenantRunLeases.acquire` (one Lua script: prune expired, count, add under the cap) | same — `.release` (`ZREM`) and `.count`. The per-tenant run cap across every replica (F-067-e, automation invariant #8). Its `<tenantId>` comes from the **tick message**, not from `TenantContext`: there is no request here to have resolved a tenant, so the ambient-scope rule below cannot apply and the message is the only thing that knows whose work this is |
| `realtime:<channel>` | **pub/sub channel**, not a key (JSON `{payload}`) | — | worker-service `RealtimePublisher.publish` | gateway-service `RealtimeFanout` — one `SUBSCRIBE` per channel a replica's own sockets hold (F-067-i). `<channel>` is a realtime channel: `user:<userId>` or `tenant:<tenantId>`, so the scope is already in the name. **The prefix is applied by hand on both sides**: ioredis prepends `keyPrefix` to key arguments, and `PUBLISH`/`SUBSCRIBE` take a channel, which Redis does not count as a key — so a forgotten prefix publishes successfully into a channel nobody hears |
| `fx:rate:<currencyCode>` | string | (currency unit — planned) | (currency service — not built) | (currency conversion) |

## Rules

- A missing `session:<id>` marker means **revoked/expired -> deny**, never
  "unknown -> allow".
- **The marker's `scopeKey` decides the switch scope of an authenticated
  request** (ADR-0032, added 2026-09-10). Postgres `identity.session.scopeKey`
  stays the source of truth; this is the copy `AuthGuard` reads on the request
  it was already making, which is why the guard reads the marker rather than
  testing for its existence. `null` — a session minted before this shipped, or
  an impersonation — means the request's own scope stands, so the field rolls
  out without a flush. `auth-handler` only tests the value for non-emptiness
  (`cache.SessionActive`) and never parses it, so the shape is free to grow.
- Add a new key only through `redis.keys.ts` (+ a matching const in the Go
  service if it reads it), and record it in the table above.
- **A key built from a phone number carries `<tenantId>`.** The segment comes
  from `TenantContext.current()`, never from a parameter, and its absence is an
  error rather than an unscoped key — the same rule `withTenant` applies to a
  query (`tenant-context/contract.md` rule 3), for the same reason: the wrong
  answer here is two tenants sharing one slot.
- **A rate-limit bucket carries `<tenantId>` too, and is the one that does not
  throw.** The bucket string belongs to the route and is built from an IP, a
  chat id, a username or a phone number — every one of them the same value at
  two resellers' front doors, so without the segment one tenant's traffic
  spends another's budget and `login-failures:<identity>` lets one reseller
  lock out another's `admin` for the price of ten bad passwords (F-1206,
  catalog 20.2 layer 6). The segment is applied by `RedisKeys.rateLimit`, not
  by `rateLimitSubject()`: the two captcha routes and that login-failure bucket
  never call the subject helper, and a control that only holds where it was
  remembered is the leak ADR-0024 removes. It answers an unresolved tenant with
  the literal `none` instead of throwing, because a request to an unknown host
  is what a flood looks like and must stay countable while `TenantGuard`
  answers it a 404 — throwing would make that a 500 and an uncounted door. No
  tenant id can equal `none`, so the unresolved bucket is unreachable from
  inside a tenant.
  **What it does not buy, and what pays for it:** an attacker who can address
  N tenants gets N budgets from one IP, because the segment is chosen by
  picking a hostname. That is what "per-tenant buckets" costs and the catalog
  asks for it anyway — a shared bucket instead of a per-tenant one is the
  noisy-neighbour outage above. `ratelimit:platform:<bucket>` is the counter
  that caps the total (F-066-s): the same bucket string with no tenant in it,
  incremented beside the tenant one on every guarded route, refusing at
  `PLATFORM_RATE_LIMIT_FACTOR` times that route's own limit. The two answer
  opposite failures and neither replaces the other — the tenant counter keeps
  a neighbour's flood off your users, the platform counter keeps the flood
  from being free. `0` switches the ceiling off and writes no key.
- **A platform-wide counter goes only over a bucket built from the caller.**
  An IP or a bot chat id, never the account under attack:
  `login-failures:<identity>` counted platform-wide would lock every
  reseller's `admin` out because one reseller's was guessed at, which is the
  denial of service the rule above closed. This is why `hitPlatform` is a
  second call rather than something `hit` does for every caller — only
  `RateLimitGuard` makes it, and the login-failure counter cannot reach it by
  accident.
- **A tenant-segmented key written outside a request takes its tenant from the
  message.** ADR-0024's rule — read the segment from the ambient scope, never
  from a parameter — is a rule about *requests*, and `worker-service` serves
  none (ADR-0027). `automation:tenant-runs:*` is the first such key, and the
  reason the exception is safe is that there is nothing to forget: a tick either
  names a tenant, in which case that is the only tenant it could belong to, or
  it names none and is platform work that is never gated at all. The failure the
  ambient rule prevents — a call site written later that forgets to scope one —
  cannot arise where the scope is a field on the only input.
- **A pub/sub channel is not a key, and gets the prefix anyway.** It is in the
  table because it is in the keyspace: a `REDIS_KEYSPACE_VERSION` bump must
  abandon it with everything else, or a gateway on the old version keeps
  hearing a publisher on the new one. Redis applies none of that for you —
  channels have no expiry, no `KEYS` listing and no client-library prefixing,
  so the only thing holding the rule is that both ends build the name from
  `RedisKeys.realtimeFanout` and the caller prepends `keyPrefix` explicitly.
  Nothing is stored, so a bump costs nothing beyond the events in flight.
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
