---
id: redis-keyspace
layer: platform
status: active
version: 5
keywords: [redis, keyspace, session key, otp key, captcha key, bot link key, botlink token, tenant segment, tenant scoped key, keyspace version, TenantContextMissing, rate limit bucket, per-tenant rate limit]
source:
  - txnet-backend/auth-service/src/app/redis/redis.keys.ts
  - txnet-backend/auth-service/src/app/redis/redis.service.ts
  - txnet-backend/auth-service/src/app/auth/session/session.store.ts
  - txnet-backend/auth-service/src/app/auth/otp/otp.store.ts
  - txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts
  - txnet-backend/auth-service/src/test-support/redis-fixture.ts
  - auth-handler/internal/cache/**
  - auth-handler/internal/config/config.go
owns_tables: []
depends_on: [tenant-context]
updated: 2026-09-09
---

# redis-keyspace
**Responsibility:** the shared Redis key convention — the `<namespace>:<version>:` prefix both auth services must agree on, plus the catalogue of keys (sessions, OTP, rate limits) and their TTLs. **Not:** the auth logic that uses the keys (`identity` / `forward-auth`).
See [contract.md](contract.md) (adding a key / TTL / keyspace version) and [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | v4 -> **v5**: `ratelimit:<bucket>` becomes `ratelimit:<tenantId>:<bucket>`, so no two tenants share a counter (F-066-o, catalog 20.2 layer 6). No `REDIS_KEYSPACE_VERSION` bump — these are TTL'd counters and orphaning them resets rate limits at deploy, which is harmless. `auth-handler` does not read `ratelimit:*`, so no Go change |
| 2026-09-09 | v4, and `REDIS_KEYSPACE_VERSION` **v2 -> v3**: the six keys built from a phone number carry `<tenantId>`, read from the ambient scope (ADR-0023, ADR-0024). `session:*` is untouched, so `auth-handler` needs no Go change. Adds `depends_on: [tenant-context]`. F-065-c |
| 2026-09-05 | v2: added `botlink:token:<token>`, `botlink:phone:<platform>:<phone>` and `botlink:chat:<platform>:<chatId>` (`BOT_LINK_TOKEN_TTL_SEC`, 900s) — a Telegram/Bale link that has not been proven yet lives only here (F-0203) |
| 2026-09-05 | Added `captcha:challenge:<id>` (60s) and `captcha:verified:<token>` (120s) for auth-api's captcha gate (F-0201) |
| 2026-09-05 | SYNC: dropped the `app/redis/**`, `app/auth/session/**`, and `app/auth/captcha/**` blankets from `source:`, replaced with the exact files this unit owns (`redis.keys.ts`, `redis.service.ts`, `session.store.ts`, `otp.store.ts`). The captcha glob had no unit-id/alias match (mirror-rule break per `tools/drift.py`) and also claimed `captcha.controller/service/schema.ts` — business logic that belongs to `auth-api` (already documents captcha/bot-check as its own feature), not key-naming. Docs-only; no behavior change. |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
