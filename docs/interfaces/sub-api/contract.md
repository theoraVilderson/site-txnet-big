---
id: sub-api
layer: interface
status: active
version: 1
updated: 2026-09-24
---

# Contract — sub-api

**Partly built.** F-113-a is the deployable, the route and the host/token gate
(`sub-service/`); F-113-b is the base64 body; F-113-c the cache and
`Profile-Update-Interval`; F-609 `Subscription-Userinfo` and the inactive
Grant; F-609-b its live usage. The other formats are the later F-113-* rows. The *why* is in ADR-0082 and ADR-0083. The spec is catalog §7.5
(`python3 tools/spec.py --section 7.5`), F-113 and F-609.

## TL;DR
One URL per Grant, `https://<tenant subscription domain>/sub/{token}`. It
answers every client app with the Grant's configs from every healthy panel,
merged, in the format the app reads. It never writes Postgres and never
contacts a panel.

## Provides
| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `GET /sub/{token}` | the token in the path; `User-Agent`; optional `?format=` | the rendered body, `Subscription-Userinfo` (F-609), `Profile-Update-Interval` | sync | see "Who is answered" below. A Grant that is not active → `200` with an empty but valid body and zero remaining, **never a 4xx** |

### Who is answered (F-113-a, built)
1. The host is normalised exactly as `shared-core` `normalizeHost` does (lowercase,
   port dropped, root dot removed); `sub/host.go` is its Go twin.
2. Its `tenant_domain` row must have `purpose = subscription` and be routable:
   a `subdomain`, or a `custom_domain` that is `verified` (the resolver's rule).
3. The Grant is read by `subscriptionTokenHash` = SHA-256 of the path token;
   the raw token never reaches the store or a log.
4. The Grant's `tenantId` must be the domain's.

Any miss is the **same** `404` and body, so a token cannot be probed from
another tenant's domain. A database error is `503`, never `404`: a client app
may drop a subscription on a 404. Only `GET`; any other method (a preflight
included) is the mux's `405`. Every answer is `Cache-Control: no-store`.
A read of the Grant's configs that fails is also `503`, never an empty body:
an app that reads an empty body drops every server it had.

### What is served (F-113-b, built)
`sub/render.go`. A config's stored lines (network `contract.links.md` rule 7)
reach the body only when all of these hold:

1. **Its panel still serves users:** `panelState` is `healthy`, `degraded` or
   `throttled_or_blocked`. Every state is judged from the panel's *admin API*
   (network `contract.budget.md`); the last two are a working panel that
   answered oddly or refused us. `down` and `maintenance` are left out, and so
   is any state added later until it is named in `servingPanelStates`.
2. **It is live:** `status = active` and `desiredRemote = present`. A frozen
   or disabled client is disabled on the panel, so its lines are dead links.
3. **Its lines are from the client it is now:** `linksUuid = uuid`. After a
   regenerate the old lines name a revoked uuid; the config contributes
   nothing until the next pass captures again.

Order: configs oldest first (`createdAt`, then `id`), each config's lines in
the panel's order. The body is those lines joined by `\n` in standard padded
base64, `text/plain; charset=utf-8`. No lines is an empty body.

**Only an `active` Grant is served.** Any other status (`pending`, `suspended`,
`exhausted`, `expired`, `cancelled`) is a `200` with an empty body, and its
configs are not read (F-609).

Format: `?format=` when it names one (`base64`, `clash`, `singbox`/`sing-box`,
`xray`, any case), else the `User-Agent` (Clash / mihomo / Stash → Clash;
sing-box / SFA / SFI / SFM → Sing-box), else base64. An unknown `?format=` is
ignored, never a 4xx. A format not rendered yet is answered with base64:
Clash, Sing-box and Xray JSON are F-113-f; Outline waits for F-407.

### Subscription-Userinfo (F-609, built)
`sub/userinfo.go`. Every `200` carries
`Subscription-Userinfo: upload=0; download=<used>; total=<cap>; expire=<unix>`,
which client apps show as used, remaining and expiry. An app reads
`total=0` as unlimited and `expire=0` as never.

1. **Used is the Grant's consumed bytes, all of it `download`.** The Grant
   keeps one figure, not split by direction. It is the larger of
   `grant.consumedBytes` as the render read it and `sub:usage:<grantId>`
   (F-609-b, rule 5): both only grow, so the larger is the newer.
2. **Cap:** a `prepaid` Grant with `quotas.traffic_bytes.limit` → that limit
   plus the sum of its `traffic_bytes` QuotaAdjustments not yet expired
   (rollover, F-604, shows here), never below `1`. A `metered` Grant, or no
   readable limit → `0`: a metered Grant buys blocks just before use
   (ADR-0072), so `purchasedBytes` would always look nearly empty (user,
   2026-09-24).
3. **A Grant that is not active shows zero remaining:** `download = total =
   max(consumedBytes, 1)`, never `total=0`.
4. `expire` is `endsAt` in Unix seconds; `0` for a permanent Grant.
5. **Usage is live on every answer, cached or not (F-609-b).** metering-service
   writes a Grant's total to `sub:usage:<grantId>` after each charge commits
   (billing `contract.metering.md`, F-609-a). A cache hit reads it in the
   stamps' `MGET`, so the hit stays two round trips; a render reads it with
   one `GET` after its Postgres reads, listener or not (it is not the cache).
   The entry stores the Grant's userinfo inputs, not the header, and the
   header is rebuilt each time. A missing, unreadable or lower key, or Redis
   failing, shows the render's own figure — the key is never the truth, and
   it outlives the render (`SUB_USAGE_TTL_SECONDS` ≥ `SUB_RENDER_TTL`).
   `consumedBytes` still fires no trigger; `endsAt`, `quotas`, `billingMode`
   and a new traffic adjustment do (user, 2026-09-24).

### The cache (F-113-c, built)
`sub/cache.go`, ADR-0083. A `200` is stored in Redis under
`sub:render:r<revision>:<tokenHash>:<format>:<host>` for `SUB_RENDER_TTL`
(default `1h`, whole hours only). Every `200`, cached or not, carries
`Profile-Update-Interval` = that TTL in hours. A refusal is never cached.

1. **Served only while nothing it was built from changed.** Triggers on
   `network.panel`, `network.config`, `entitlement.grant`,
   `entitlement.quota_adjustment` and `tenant.tenant_domain` NOTIFY
   `sub_invalidate`. The listener stamps
   `sub:changed:{panel|grant|tenant}:<id>` with the Redis time. An entry
   records the Redis time taken **before** its first Postgres read. It is
   served only while the stamps of `all`, its Grant, its tenant and every
   panel it has a config on (served or not) are all older than that time.
2. **A (re)connected listener stamps `all`**, so a notification lost while
   nobody listened outdates everything, not nothing.
3. **No live listener in this process: no cache.** Nothing is read or
   written. Redis failing is a miss, never an error answer.
4. A render that starts reading a column no trigger watches adds it to the
   trigger in the same row (ADR-0083 revisit trigger).
5. `renderRevision` is bumped when the same lines render differently, so a
   rolling deploy cannot serve one version's bodies to the other.

## Emits (events)
None.

## Consumes
| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| entitlement | `grant` by `subscriptionTokenHash` (SHA-256 lowercase hex of the path token), its status, billing mode, `endsAt`, `consumedBytes`, traffic quota and unexpired traffic `quota_adjustment` rows | a cached render is still served until its TTL; with no cache, `503` |
| network | each config's stored link lines, and which panels are healthy | the same |
| tenant | the request host must be a `purpose = subscription` domain of the Grant's tenant (F-066-q); `TenantStatusPolicy` column `subscriptionLink` (`tenant/rules.md`) | a refused tenant is served the empty body, as an inactive Grant is |
| redis-keyspace | the cached render and the change stamps ("The cache" above; C-07's key, ADR-0083 (3)); `sub:usage:<grantId>`, written by billing's metering-service (F-609-a), key name held to `contracts/redis/keyspace.json` `subKeyCases` by `usage_test.go` | a miss renders from Postgres reads; no usage key shows the render's figure |

## Guarantees
- **No Postgres write**, ever, on this path. Reads happen only on a cache miss.
  Enforced, not promised: the pool opens every session with
  `default_transaction_read_only = on`, and boot refuses a session where it
  did not take. The role is `txnet_cross_tenant` (a host is resolved before a
  tenant is known); boot also refuses a missing column it reads.
- **No panel request**, ever (ADR-0082 decision 2).
- p99 under 50 ms from cache: a hit is two Redis round trips (`GET`, `MGET` —
  the stamps and the live usage together) and no Postgres read.
- A rotated token stops working at once, not at the next cache expiry.
- The origin is independent (catalog C-16): no cookie is set or read, there is
  no CORS to the panel domain, and the token in the path is the only
  authentication.
- No panel host or panel URL appears in any response (catalog C-17).

## Deprecations
| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
