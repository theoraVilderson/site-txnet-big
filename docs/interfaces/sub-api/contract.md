---
id: sub-api
layer: interface
status: active
version: 1
updated: 2026-09-24
---

# Contract — sub-api

**Partly built.** F-113-a is the deployable, the route and the host/token gate
(`sub-service/`); F-113-b is the base64 body. The other formats, the headers
and the cache are the later F-113-* rows and F-609. The *why* is in ADR-0082. The spec is catalog §7.5
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

Format: `?format=` when it names one (`base64`, `clash`, `singbox`/`sing-box`,
`xray`, any case), else the `User-Agent` (Clash / mihomo / Stash → Clash;
sing-box / SFA / SFI / SFM → Sing-box), else base64. An unknown `?format=` is
ignored, never a 4xx. A format not rendered yet is answered with base64:
Clash, Sing-box and Xray JSON are F-113-f; Outline waits for F-407.

## Emits (events)
None.

## Consumes
| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| entitlement | `grant` by `subscriptionTokenHash` (SHA-256 lowercase hex of the path token), its status, period and bytes | a cached render is still served until its TTL; with no cache, `503` |
| network | each config's stored link lines, and which panels are healthy | the same |
| tenant | the request host must be a `purpose = subscription` domain of the Grant's tenant (F-066-q); `TenantStatusPolicy` column `subscriptionLink` (`tenant/rules.md`) | a refused tenant is served the empty body, as an inactive Grant is |
| redis-keyspace | the cached render, keyed by catalog C-07: `(grantId, healthyPanelSetHash, activeDomainSetHash, format)` | a miss renders from Postgres reads |

## Guarantees
- **No Postgres write**, ever, on this path. Reads happen only on a cache miss.
  Enforced, not promised: the pool opens every session with
  `default_transaction_read_only = on`, and boot refuses a session where it
  did not take. The role is `txnet_cross_tenant` (a host is resolved before a
  tenant is known); boot also refuses a missing column it reads.
- **No panel request**, ever (ADR-0082 decision 2).
- p99 under 50 ms from cache.
- A rotated token stops working at once, not at the next cache expiry.
- The origin is independent (catalog C-16): no cookie is set or read, there is
  no CORS to the panel domain, and the token in the path is the only
  authentication.
- No panel host or panel URL appears in any response (catalog C-17).

## Deprecations
| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
