---
id: sub-api
layer: interface
status: draft
version: 1
updated: 2026-09-24
---

# Contract — sub-api

**Draft: this is the shape the F-113-* rows build, and none of it exists yet.**
The *why* is in ADR-0082. The spec is catalog §7.5
(`python3 tools/spec.py --section 7.5`), F-113 and F-609.

## TL;DR
One URL per Grant, `https://<tenant subscription domain>/sub/{token}`. It
answers every client app with the Grant's configs from every healthy panel,
merged, in the format the app reads. It never writes Postgres and never
contacts a panel.

## Provides
| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `GET /sub/{token}` | the token in the path; `User-Agent`; optional `?format=` | the rendered body, `Subscription-Userinfo` (F-609), `Profile-Update-Interval` | sync | unknown token → `404`. A Grant that is not active → `200` with an empty but valid body and zero remaining, **never a 4xx** |

Formats: base64 URI first (F-113-b); Clash, Sing-box and Xray JSON later
(F-113-f). Outline waits for F-407. An unknown `User-Agent` gets base64.

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
