---
id: redis-keyspace
layer: platform
status: active
version: 1
updated: 2026-09-04
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
| `fx:rate:<currencyCode>` | string | (currency unit — planned) | (currency service — not built) | (currency conversion) |

## Rules

- A missing `session:<id>` marker means **revoked/expired -> deny**, never
  "unknown -> allow".
- Add a new key only through `redis.keys.ts` (+ a matching const in the Go
  service if it reads it), and record it in the table above.
- Never store money or anything that must survive a keyspace-version bump.

## Guarantees

- Counter keys always get their TTL atomically on the first increment (Lua), so
  a crash between `INCR` and `EXPIRE` cannot leak a permanent key.
- OTP verify (`peekForVerification`) is atomic via Lua: read + increment under
  `KEEPTTL` + self-destruct after 5 attempts.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| hand-written key strings outside `redis.keys.ts` | 2026-09-04 | — | `RedisKeys.*` builders |
