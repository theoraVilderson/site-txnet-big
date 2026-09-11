---
id: redis-keyspace
layer: platform
status: active
version: 5
keywords: [redis, keyspace, session key, otp key, captcha key, bot link key, botlink token, tenant segment, tenant scoped key, keyspace version, TenantContextMissing, rate limit bucket, per-tenant rate limit]
source:
  - contracts/redis/keyspace.json
  - txnet-backend/shared-core/src/lib/redis/**
  - auth-handler/internal/cache/keys.go
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
updated: 2026-09-11
---

# redis-keyspace
**Responsibility:** the shared Redis key convention — the `<namespace>:<version>:` prefix both auth services must agree on, plus the catalogue of keys (sessions, OTP, rate limits) and their TTLs. **Not:** the auth logic that uses the keys (`identity` / `forward-auth`).
See [contract.md](contract.md) (adding a key / TTL / keyspace version) and [open-questions.md](open-questions.md).
## Changelog
| Date | Change |
|---|---|
| 2026-09-11 | Every Redis lifetime becomes a `RedisTtl` entry in `shared-core/src/lib/redis/ttl.ts`, including the impersonation window and the two `bot-service` env defaults that re-spelled it. `loginFailureWindow` was in the catalogue and imported nowhere. The TTL *relationships* are asserted now, not just described. spec: F-078 |
| 2026-09-11 | The four per-app key builders merge into `shared-core/src/lib/redis/keys.ts`; each app keeps a shim so no import site moved. `auth-handler` gets the Go builder C-03 has required since it was written — it had been concatenating `keyPrefix + "session:" + id` inline. **No key changed shape**: every per-service snapshot gained entries and modified none. spec: F-076 |
| 2026-09-11 | The keyspace prefix gets one declared home (`contracts/redis/keyspace.json`) and one value: **`v2`**, on the user's call. The defaults had disagreed three ways and the fleet was split — 8 live sessions under `v1`, 7 under `v2`, none under `v3`. The `v1` eight were signed out. spec: F-075 |
| 2026-09-09 | v4 -> **v5**: `ratelimit:<bucket>` becomes `ratelimit:<tenantId>:<bucket>`, so no two tenants share a counter (F-066-o, catalog 20.2 layer 6). No `REDIS_KEYSPACE_VERSION` bump — these are TTL'd counters and orphaning them resets rate limits at deploy, which is harmless. `auth-handler` does not read `ratelimit:*`, so no Go change |
| 2026-09-09 | v4, and `REDIS_KEYSPACE_VERSION` **v2 -> v3**: the six keys built from a phone number carry `<tenantId>`, read from the ambient scope (ADR-0023, ADR-0024). `session:*` is untouched, so `auth-handler` needs no Go change. Adds `depends_on: [tenant-context]`. F-065-c |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
