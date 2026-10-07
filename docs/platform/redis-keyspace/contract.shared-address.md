---
id: redis-keyspace
layer: platform
status: active
version: 5
updated: 2026-10-07
---

# Contract — redis-keyspace: a per-IP limit behind a shared address

ADR-0129 amendment 2 (D-71), row EDGE-1-l. Behind a reseller's own CDN, the
verified address (`req.ip`, hosting `contract.origin.md` O5) is that CDN's
edge, and every visitor it serves shares it. The gateway forwards what the CDN
claims the visitor was as `X-Edge-Claimed-Ip` (O9). This file is how the
limiter counts that claim. The rule: **count it, never trust it.**

**S1 — Which buckets.** `claimedAddressOf(req, bucket)` returns the claim only
for a bucket keyed on `req.ip` (`bucket` ends `:<req.ip>`). The claim must also
be one IP address and differ from `req.ip`. A bucket naming a user, a chat or
the account under attack (`login-failures:<identity>`, `otp-phone:<phone>`) is
never split. Those limits stay the backstop against a forged claim.

**S2 — Two counters for one.** `RateLimiter.hitCaller(bucket, limit, window, claim)`:

| counter | key | refuses above |
|---|---|---|
| fine, tenant | `ratelimit:<tenantId>:<bucket>~<claim>` | the route's limit |
| coarse, tenant | `ratelimit:<tenantId>:<bucket>` | limit x `SHARED_ADDRESS_FACTOR` (20) |
| fine, platform | `ratelimit:platform:<bucket>~<claim>` | limit x `PLATFORM_RATE_LIMIT_FACTOR` |
| coarse, platform | `ratelimit:platform:<bucket>` | limit x 20 x `PLATFORM_RATE_LIMIT_FACTOR` |

All four are incremented before any is judged, as F-066-s spends two today.
Without a claim it is the two counters it replaced, with unchanged keys. The
key shapes are the catalogue's `ratelimit:` rows: the claim rides inside
`<bucket>`.

**S3 — What it buys, what it costs.** Visitors behind one edge each get the
route's limit, so one attacker there spends only their own. A caller who
invents a claim per request opens a new fine counter each time, and the
address it really came from stops them at 20x the limit. The per-account and
per-phone limits stay unchanged. A CDN whose header the gateway does not list
is read from the entry it appended to `X-Forwarded-For` (hosting O9).

**S4 — Who calls it.** `RateLimitGuard` (every `@RateLimit` route) and
tenant-service `PublicHostMiddleware` (`/api/public/*`). A new per-IP spender
calls `hitCaller` with `claimedAddressOf`, never `hit` + `hitPlatform`.
`req.ip` stays the verified address for every other use: audit, fraud and logs.

Tests: `shared-core/src/lib/rate-limit/shared-address.spec.ts`.
