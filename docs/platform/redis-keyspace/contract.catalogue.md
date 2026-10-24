---
id: redis-keyspace
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — redis-keyspace: the key catalogue (names are *after* the prefix)

A topic file of `contract.md` (§10): every key this platform writes. The
prefix, the rules and how to add a key are in `contract.md`; moved here
2026-10-24 when the catalogue outgrew it (OPS-1-ag).


`<phone>` is always the E.164 form (`+989123456789`, ADR-0018) — the same
string the database stores, so a key and a row can never disagree about which
number they mean.

`<tenantId>` is the tenant the request resolved to. It appears on the keys
built from a phone number, and on `botlink:chat:*`, whose chat id has the same
problem for the opposite reason (F-066-l): a phone number identifies a person
**within** a tenant and not across the platform (ADR-0023), while a chat id is
issued by the messenger and is therefore identical in every reseller's bot.
Without the segment two resellers selling to the same person share one OTP
slot, and identity invariant #10 — one active code per (phone, purpose) —
enforces itself across the tenancy boundary, evicting one reseller's code when
the other issues theirs. It is the tenant **id**, never the slug, so renaming a
reseller does not lose the code it just issued.

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

Several lifetimes are **relationships**, asserted by `ttl.spec.ts`: a pending
registration outlasts the code that unlocks it, a delivery status does not
outlast its code, and a realtime channel does not outlast its result. None
fails loudly — a valid OTP that verifies nothing, or a socket held open for an
event that never comes.

| Key | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `session:<sessionId>` | string (JSON `{userId,revoked,scopeKey}`) | session lifetime (default 30d; 30m for impersonation) | auth-service `SessionStore.register` | auth-service `AuthGuard` (`SessionStore.read`), auth-handler `/validate` |
| `user:<userId>:sessions` | set of sessionIds | = session lifetime | auth-service `SessionStore` | auth-service (bulk revoke) |
| `role:<roleId>:permissions` | string — fingerprint of the role's permission set (ADR-0043) | none | auth-service, on a Postgres notification (F-101-b) | auth-handler `/validate`, auth-service `PermissionStateStore` — **missing means unknown, never changed** |
| `user:<userId>:role` | string — the role the user holds now (ADR-0043) | none | auth-service, on a Postgres notification (F-101-b) | auth-handler `/validate`, auth-service `PermissionStateStore` — missing means unknown |
| `user:<userId>:permissions` | string — fingerprint of the person's own answer, only while something beyond their role applies (ADR-0138) | none | auth-service, on a Postgres notification; **deleted** when nothing beyond the role applies | auth-handler `/validate`, auth-service `PermissionStateStore` — present, it decides alone; missing, the role's key decides |
| `otp:code:<tenantId>:<purpose>:<phone>` | string (JSON `{codeHash,attemptCount}`) | 300s | auth-service `OtpStore.save` | auth-service verify Lua script |
| `otp:lock:<tenantId>:<purpose>:<phone>` · `otp:cooldown:<tenantId>:<purpose>:<phone>` | string · string | 2s · 60s | `OtpStore.acquireLock` (`SET NX`) · `OtpStore.startCooldown` | — · `OtpStore.isCoolingDown` |
| `otp:resend:<tenantId>:<step>:<phone>` | counter (uses spent) | 300s (= the code) | auth-service `OtpResendGrants.grant`, by `login/otp/request`, `register` and `password/forgot` once the captcha passed — for any number (F-0201-f) | `OtpResendGrants.spend` (Lua: exists, `INCR` ≤ 3) on `POST /auth/otp/resend` |
| `ratelimit:<tenantId>:<bucket>` | counter | window seconds (per call site) | `RateLimiter.hit` (`INCR` + `EXPIRE` on first hit, Lua) — in `shared-core/src/lib/rate-limit/` since F-092-r, counted by auth-service and billing-service, each through its own `RedisService` bound as `RATE_LIMIT_STORE` | same. `<tenantId>` is `none` when the request resolved to no tenant — this is the one tenant-segmented key that does not throw without a scope (F-066-o) |
| `ratelimit:platform:<bucket>` | counter | window seconds (same as the tenant counter beside it) | `RateLimiter.hitPlatform` (`INCR` + `EXPIRE` on first hit, Lua) | same. The same bucket with no tenant in it, so one caller's traffic across every tenant it can name lands in one counter (F-066-s). `platform` is a literal in the tenant-id position, like `none` |
| `outbound:bot:send:<tenantId>:<platform>` | counter | 1s | `BotSendPacer.take` (bulk, deferrable) and `.spend` (interactive, never refused) — `INCR` + TTL on first hit, in `messenger`, bound to a `RedisService` as `SEND_RATE_STORE` by every app that sends — notification, bot and auth (F-313-a/c, ADR-0066) | same. The one **outbound** counter: what this platform may send, not what it will accept, which is why it is not under `ratelimit:`. No tenant segment of its own — a delivery run has no `TenantContext`, so the tenant is inside the bucket's subject |
| `register:pending:<tenantId>:<phone>` | string (JSON profile + password hash) | 600s | auth-service `RegisterService.register` | auth-service `RegisterService.verifyPhone` |
| `bot:nav:<platform>:<integrationId>:<chatId>` | string (JSON `NavState`: flow, step, collected fields, last view) | `BOT_NAV_TTL_SEC` (1800s) | bot-service `ConversationStore.save` | bot-service `ConversationRouter` |
| `bot:session:<platform>:<integrationId>:<chatId>` | string (JSON `{refreshToken,signedInAt}`) | `BOT_SESSION_TTL_SEC` (30d, idle — pushed out on every read) | bot-service `BotSessionStore.save` | bot-service (menu, `/logout`) |
| `bot:lang:<platform>:<integrationId>:<chatId>` | string (a language code) | `BOT_LANG_TTL_SEC` (180d, idle) | bot-service `ChatLanguage.choose` | bot-service `ChatLanguage.resolve` |
| `bot:guidefile:<platform>:<integrationId>:<objectKey>` | string (the platform's `file_id` for a guide file this bot sent) | `RedisTtl.botGuideFile` (90d) | bot-service `GuideMediaSender` | the same (F-414-f) |
| `bot:stale-notice:<platform>:<integrationId>:<chatId>` | string (`1`) | `RedisTtl.botStaleNotice` (600s) | bot-service `StaleUpdateNotice.tell` (`SET NX`) | the same — a chat's stale backlog is told once (hosting H19) |
| `guide:seen:<tenantId>:<guideId>:<day>:<surface>:<viewerHash>` | string (`1`) | `RedisTtl.guideViewSeen` (48h) | tenant-service `GuideStats.view` (`SET NX`) | the same (F-414-l) |
| `botlink:token:<token>` | string (JSON pending link: platform, phone, purpose, lang, state, otpSent) | `BOT_LINK_TOKEN_TTL_SEC` (900s) | auth-service `BotLinkStore.save/update` | the bot webhook + the client's status poll |
| `botlink:phone:<tenantId>:<platform>:<phone>` | string (the live token) | = above | `BotLinkStore.save` | `BotLinkStore.byPhone` — makes a repeated link request idempotent |
| `botlink:chat:<tenantId>:<platform>:<chatId>` | string (the token this chat is answering) | = above | `BotLinkStore.bindChat` on `/start <token>` | `BotLinkStore.byChat` when the contact arrives — the contact update carries no token of its own. Tenant-scoped since F-066-l: the chat id is the messenger's, so the same person is the same id in every reseller's bot and the second `/start` used to overwrite the first's pointer. The **tenant**, not the bot, is the segment — catalog 10.5 links a person per tenant, so two `/start`s in one reseller's bots are one conversation |
| `captcha:challenge:<challengeId>` | string (issue timestamp, ms) | 60s | auth-service `CaptchaService.issueChallenge` | auth-service `CaptchaService.verifyChallenge` (deletes on first check — single-use) |
| `captcha:verified:<token>` | string (`"1"`) | 120s | auth-service `CaptchaService.verifyChallenge` | auth-service `CaptchaService.consumePass` (deletes on first check — single-use) |
| `handoff:<code>` | string (JSON `{userId,tenantId}`) | 60s | auth-service `HandoffService.issue`, on the platform's host (F-061-f) | `HandoffService.redeem` on the named tenant's panel domain (`GET`, then `DEL` — single-use). Unscoped like `otp:channel`: written and spent under two tenants; the value names the one that may spend it |
| `tenant:host:<normalizedHost>` | string (JSON `HostSurface` = `{id,slug,ownerUserId,purpose,domainType,tenantType}` — one shape in `shared-core/src/lib/tenant/host-surface.ts`; an entry missing a field re-reads (ADR-0059) — or `-` for *no tenant*) | 600s resolved / 60s miss — a **backstop**, not the mechanism | auth-service `TenantCacheService.byHost`; tenant-service `HostSurfaceCache` (F-018-al) | auth-service `TenantResolverService`; tenant-service's public routes; deleted by `invalidateDomain` on every domain create/verify/switchover/delete (ADR-0025). **Two writers, one key on purpose** — a second key would be a second thing to delete at each of those sites, and the one missed outlives a change of owner |
| `tenant:id:<tenantId>` | string (JSON `{id,slug,ownerUserId}` — an entry without the owner re-reads (F-061-k) — or `-` for *no tenant*) | = above | auth-service `TenantCacheService.byId` | auth-service `TenantResolverService` (the owner check through a bot, ADR-0059 (6)); deleted by `invalidateTenant`, and with the host entries by shared-core `invalidateTenantOwner` on every write of `ownerUserId` |
| `tenant:status:<tenantId>` | string (JSON `{status, graceEndsAt, onboarding}`) | none | tenant-service `TenantStatusListener`, on a Postgres notification — of a status **or a domain** change — and for every tenant on connect (F-018-f, moved F-018-w; `onboarding` computed from the tenant's domains, F-018-l) | `TenantStatusGuard` (shared-core) in auth-, billing- and notification-service; worker-service `TenantStatusGate` (F-018-p); gateway-service `TenantSocketWatch` (F-018-r); sub-service `/sub`, the `subscriptionLink` column in Go (F-113-e, name held to `contracts/redis/keyspace.json`) — **missing means unknown, refuses nobody** |
| `tenant:status-changed` | **pub/sub channel**, not a key (body: a tenant id) | — | tenant-service `TenantStatusListener`, after rewriting that tenant's `tenant:status` (F-018-r) | gateway-service `TenantSocketWatch` — re-reads the key and closes the tenant's sockets if it no longer reads; the body carries no authority. Prefix by hand, as for `realtime:<channel>` |
| `ai:silence:all`, `ai:silence:tenant:<tenantId>` | string (the end, ISO instant) | until that end, ≤ 7 days | ai-service `SilenceSwitch.set`, behind the service-only `PUT /api/internal/ai/silence` (F-1548) | ai-service `SilenceSwitch.state` (`MGET` of both) — set means no proactive AI message; **fails closed**: an unreadable Redis holds the engine. Platform-owned: no tenant route reaches it |
| `automation:tenant-runs:<tenantId>` | sorted set (lease token -> expiry ms) | `AUTOMATION_RUN_TIMEOUT_MS` (600s), re-armed on every grant | worker-service `TenantRunLeases.acquire` (one Lua script: prune expired, count, add under the cap) | same — `.release` (`ZREM`) and `.count`. The per-tenant run cap across every replica (F-067-e, automation invariant #8). Its `<tenantId>` comes from the **tick message**, not from `TenantContext`: there is no request here to have resolved a tenant, so the ambient-scope rule below cannot apply and the message is the only thing that knows whose work this is |
| `realtime:<channel>` | **pub/sub channel**, not a key (JSON `{payload}`) | — | worker-service `RealtimePublisher.publish` | gateway-service `RealtimeFanout` — one `SUBSCRIBE` per channel a replica's own sockets hold (F-067-i). `<channel>` is a realtime channel: `user:<userId>` or `tenant:<tenantId>`, so the scope is already in the name. **The prefix is applied by hand on both sides**: ioredis prepends `keyPrefix` to key arguments, and `PUBLISH`/`SUBSCRIBE` take a channel, which Redis does not count as a key — so a forgotten prefix publishes successfully into a channel nobody hears |
| `fx:rate:<currencyCode>` | string (JSON `{snapshotId,currencyCode,rate,source,effectiveAt}`) | **none — deliberately** | worker-service `FxRateSnapshotStore.publish`, on every accepted poll of `fx_rate_refresh`, one key per `FX_CURRENCIES` code (F-0606-a, F-116-i) | same — `.lastAccepted`, which is F-0605's deviation baseline; and every other service through shared-core `readFxRate`/`readFxPair` only (F-116-c; billing's `FxRateReader` is one). A **cache of the `currency.CurrencyExchangeRate` row**, not a second copy of the number: it carries the snapshot id so a quoted price can record which rate it was priced at, and `effectiveAt` so F-0607-a's staleness ladder can judge its age without a query. That ladder is why there is no TTL — an expiry would delete the evidence it is made of and turn a rate it would have called *degraded* into *no rate at all*, silently. A miss is answered from the table |
| `fx:reading:<currencyCode>` | string (JSON `{rate,at,outcome,used,sources,reason}`) | none | worker-service `FxRateSnapshotStore.recordReading`, every `fx_rate_refresh` run, accepted or not (F-0608-a) | currency-service's pin form (`GET /api/currency/pins/:code`) only. **Never a rate**: the last download, shown as a suggestion (ADR-0101 part 4); nothing prices from it |
| `sub:render:r<revision>:<tokenHash>:<format>:<host>` | string (JSON `{built, deps, contentType, body}`) | `SUB_RENDER_TTL` (1h) | sub-service `RenderCache.store` on a `200` (F-113-c) | sub-service `RenderCache.lookup` — served only while every stamp in `deps` is older than `built` (ADR-0083). Go-only builders in `sub-service/internal/cache/keys.go`; `<tokenHash>` is the SHA-256, never the token |
| `sub:changed:<panel\|grant\|tenant>:<id>`, `sub:changed:all` | string (Redis `TIME`, µs) | 2 × `SUB_RENDER_TTL` + 60s | sub-service `invalidate.Listener`, on each `sub_invalidate` notification; `all` on every (re)connect | sub-service `RenderCache.lookup` (`MGET`). A missing stamp means *never changed* — which is why it outlives every entry it can outdate |
| `sub:usage:<grantId>` | string (decimal `consumedBytes`) | `SUB_USAGE_TTL_SECONDS` (24h, ≥ `SUB_RENDER_TTL`), refreshed on each write | metering-service `SubUsagePublisher`, after each charge commits (F-609-a) — one Lua script that never lowers the value, since `consumedBytes` only grows and replicas reach Redis out of order | sub-service, for `Subscription-Userinfo` (F-609-b). **Cross-language**: declared in `contracts/redis/keyspace.json` `subKeyCases`. Never the truth — a miss uses the render's figure, and a failed write never fails the delta |
| `release-flag:<key>` | string (JSON `{stage, platformTenantId, on, off}` — one flag whole) | `RELEASE_FLAG_CACHE_TTL_S` (300s) — a **backstop**, not the mechanism | shared-core `ReleaseFlags.state` on a miss (OPS-1-ag) | `ReleaseFlags.isOn` in any service; deleted by every tenant-service release-flag write, inside its transaction and again after the commit (tenant `contract.release-flags.md` R4). Unscoped: a flag is the platform's, asked for whichever tenant a service serves |
