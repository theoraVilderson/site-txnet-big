---
id: sub-api
layer: interface
status: active
version: 1
keywords: [subscription link, sub link, /sub, sub endpoint, subscription url, sub-service, subscription domain, subscription token, subscription-userinfo, remaining quota in the app, profile-update-interval, clash, sing-box, v2rayng, base64 subscription, لینک اشتراک, لینک ساب, ساب, لینک سابسکریپشن]
source: [sub-service/**, txnet-backend/prisma/domains/migrations/20260924000700_sub_is_told_what_changed/**, txnet-backend/prisma/domains/migrations/20260924000800_sub_hears_a_grants_quota/**]
owns_tables: []
depends_on: [network, entitlement, tenant, redis-keyspace]
updated: 2026-09-24
---

# sub-api

**Responsibility (one sentence):** `GET /sub/{token}` on a tenant's
subscription domain (F-113): one link per Grant that renders the stored link
lines of all its configs, served by its own Go deployable `sub-service`
(ADR-0082).
**Explicitly NOT responsible for:** capturing or storing link lines (`network`),
issuing or rotating the token (`entitlement`, F-502-p), deciding what a tenant's
status allows (`tenant`, `TenantStatusPolicy`), any panel request.

Built: the deployable, the host/token gate (F-113-a), the base64 body of
the served configs' stored lines (F-113-b) and the Redis render cache,
invalidated by Postgres notifications (F-113-c, ADR-0083), and
`Subscription-Userinfo` with the inactive Grant's empty body (F-609), its
used figure live from Redis on every answer (F-609-b), and the tenant
status gate (F-113-e). The rest is the F-113-* series and F-027-bi..bm in `BACKLOG.md`.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | building `sub-service`, or a client app / unit that relies on `/sub` |

## Changelog
| Date | Change |
|---|---|
| 2026-09-24 | Unit created, `draft`: its own deployable and stored link lines (ADR-0082) |
| 2026-09-24 | `active`: `sub-service` serves `GET /sub/{token}` behind the host/token gate (F-113-a) |

<!-- INDEX.md is a router. ≤40 lines. Never put detail here. -->
