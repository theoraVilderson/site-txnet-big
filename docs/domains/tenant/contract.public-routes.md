---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-09-20
---

# tenant — public routes (the prefix nobody signs in to)

Everything under `/api/public/<service>/`: how such a route learns its tenant,
and what it costs a stranger to ask. The routes themselves are documented where
they belong — files in [`platform/object-storage`](../../platform/object-storage/INDEX.md),
branding in [contract.branding.md](contract.branding.md), the domain probe in
[contract.domains.md](contract.domains.md), the door question in
[contract.onboarding.md](contract.onboarding.md).

Scheme and enforcement: ADR-0065 (F-018-ak). Caching and limits: F-018-al.

## Adding one

A controller under `publicPath('tenant', '<route>')` and a
`@PublicRoute({ doors })`. Nothing else — not a Traefik rule, not a middleware
entry, not a rate limit. Three things then hold without opting in:

| | what holds | where |
|---|---|---|
| 1 | Traefik sends `/api/public/tenant` on without `my-auth` | one router pair, `dev-docker/docker-compose.main.yml` |
| 2 | the Host names the surface, and its tenant's scope is open for the request | `PublicHostMiddleware` |
| 3 | the route answers only on the doors it declared; anything else is the neutral 404 | `PublicRouteGuard` |

A handler under `public/` **without** the decorator is a 404, not an open
route, and `public-routes.spec.ts` fails on one.

## What a request costs

Both controls below are the middleware's, for the whole prefix, and neither is
opted into per route. That is the point: a public route is meant to be a
controller and a decorator, so a protection each route opts into is one the
next route silently does without — on exactly the routes nobody signs in to.

### The Host lookup is cached — and it is `auth-service`'s cache

`surfaceOfHost` reads one `tenant_domain` row per request. Measured
2026-09-20 on the dev database that lookup is **~0.63 ms of server-side work**,
against a **0.071 ms p50 Redis GET**; `files/<key>` spends one per image per
visitor, so the figure that matters is not the millisecond but which machine
pays it. Postgres is the shared resource an unauthenticated route must not be
able to spend.

| | |
|---|---|
| key | `tenant:host:<normalizedHost>` — **the same entry `auth-service` writes** |
| shape | `HostSurface` (`shared-core/src/lib/tenant/host-surface.ts`): `id`, `slug`, `ownerUserId`, `purpose`, `domainType`, `tenantType` |
| a host with no row | cached as `-`, so a flood on a name nobody owns costs no query |
| lifetime | deleted on every domain create / verify / switchover / delete; the TTL is a **backstop** (ADR-0025) |
| Redis down | logged, treated as a miss — the database still knows the answer |

**The two services share one key deliberately, and therefore share one shape.**
A second key under a second name is a second thing to delete at every domain
write, and the one that gets missed outlives a change of owner — a request
served as the host's *previous* tenant. That is a cross-tenant leak, not a
stale page, which is why the invalidation is explicit and the TTL is not the
mechanism. `surfaceOfHost` selects `slug` and `ownerUserId` although no public
route reads them, for that reason alone: a value missing a field the other
service requires is a permanent miss for it.

The shape is **checked, not asserted** (`isHostSurface`). An entry written
before a field existed fails the check, re-reads and overwrites itself, so a
new field crosses a deploy without a keyspace bump.

### The prefix is rate-limited, per visitor

| | |
|---|---|
| bucket | `RateLimitBucket.PUBLIC_ROUTE` (`public:route`), subject `req.ip` |
| key | `ratelimit:<tenantId>:public:route:<ip>`, plus the platform ceiling (F-066-s) |
| budget | `PUBLIC_ROUTE_RATE_LIMIT` per 60s — 300 by default |
| over it | 429, before the route runs |

**Per IP, not per host** (user, 2026-09-20). The tenant segment is already the
host's tenant, so the budget is per reseller; making the *subject* the host too
would mean one attacker with one IP could 429 every visitor to the reseller
they aimed at. This way that attacker is cut off and the reseller's visitors
are not.

It is counted in the middleware, before every guard, so the requests
`PublicRouteGuard` answers with the neutral 404 are counted as well — a flood
on an unresolved host is still a flood, and `RedisKeys.rateLimit` files it
under `none` rather than throwing.

`req.ip` needs `trust proxy` (`TRUST_PROXY`, `main.ts`): behind Traefik the
socket's address is Traefik's, and without it every visitor shares one bucket.

## Consumers

| who | what it asks |
|---|---|
| `panel-web` | `serves-panel` before it renders; `files/<key>` and `branding` for a reseller's brand |
| any visitor's browser | `files/<key>` — the load this page's limits are sized for |
| a reseller's DNS setup | `domain-probe`, which answers on an *unverified* host by design |

## Open

`serves-panel` stays reachable from the internet (user, 2026-09-20), although
only `site-pwa`'s server calls it: it discloses one boolean a visitor can infer
from the page anyway, and carving one route out of the prefix would cost
ADR-0065's one-router-pair-per-service property.
