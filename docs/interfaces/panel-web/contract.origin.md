---
id: panel-web
layer: interface
status: active
version: 20
updated: 2026-09-19
---

# panel-web — where the browser reaches the services (F-066-u, ADR-0060)

Split out of `contract.md`, which is at the 250-line ceiling (§10).

## The rule

The panel calls every service **on the domain the page was loaded from**:
`/api/<service>` for HTTP and `REALTIME_PATH` for the socket. No origin is
built into the bundle. `lib/api-origin.ts` is the one place that says so —
`API_BASE` (`/api`) and `realtimeUrl()` (`https` page -> `wss`, on
`location.host`) — and `auth-api.ts`, `billing-api.ts`, `catalog-api.ts` and
`realtime.ts` build on it. `api-origin.test.ts` holds both to "a path, never an
origin".

Why this and nothing else: the host a call arrives on is what resolves its
tenant (ADR-0025) and the only host its refresh cookie can be stored for. With
one build-time `NEXT_PUBLIC_API_ORIGIN` every reseller's customer reached the
backend as the platform's host, and the cookie was written for `.<domain>` —
refused by the browser on a reseller's own domain.

## Who routes it

Traefik, not this app. The routers of every service the panel calls carry no
`Host(...)` and priority 120, so they answer on any host above the panel's own
router; a priority-1 `HostRegexp` router sends every other host to this app
(`dev-docker/docker-compose.main.yml`). The paths this app serves itself —
`/api/i18n/*` — are not among them and stay here. A new service the panel
calls gets its router the same shape, in the same change.

A reseller's domain has its certificate at the reseller's CDN, which points a
CNAME at the gateway; this app and Traefik hold none. Whether a host *works* is
the tenant resolver's answer: an unregistered host gets the page and a neutral
404 from every call.

## What follows from it

| | before (2026-09-05 .. 2026-09-18) | now |
|---|---|---|
| call | cross-origin to `https://api.<domain>` | same-origin `/api/<service>` |
| CORS | `FRONTEND_ORIGIN` with credentials | none needed |
| refresh cookie | `Domain=.<DOMAIN_NAME>` | host-only (`auth-api/contract.cookies.md`) |
| socket | `wss://api.<domain><REALTIME_PATH>` | `wss://<page host><REALTIME_PATH>` |
| tenant of a call | always the platform's | the domain's |

`credentials: "include"` stays on every call: same-origin it changes nothing,
and it keeps a deliberately cross-origin build working.

## Config removed

`NEXT_PUBLIC_API_ORIGIN` and `NEXT_PUBLIC_REALTIME_ORIGIN`. Nothing reads them;
a deployment still setting them sets nothing. `NEXT_PUBLIC_REALTIME_PATH` stays
— it must equal the gateway's router rule.

## A host that serves no panel (F-066-x)

Every host reaches this app, so a host that must serve nothing — a
`subscription` / `assets` domain (F-066-q), a gated reseller's platform
subdomain (F-018-ag, F-066-x) — used to render the login page with only its API
calls refused. D-01 is about what a platform host *serves*, so the page was the
violation.

`proxy.ts` now asks first, before the rename redirect and the session check:
`lib/door.ts` calls auth-service's `GET /api/auth/door` for the visitor's host
(the internal hop with `X-Forwarded-Host`, as the session check does) and, on
`serves: false`, answers a bare `404 Not Found` in plain text — no panel HTML,
no brand, no redirect. The rule itself is auth-service's
(`tenant/contract.onboarding.md` "The panel asks before it renders"); nothing
here restates it.

| the answer | the page |
|---|---|
| `200 {serves: false}` | bare 404 |
| `200 {serves: true}` | renders |
| 404 — an unregistered host | renders (F-066-u's own call) |
| timeout, unreachable, unparseable | renders |

**Every doubt renders.** The guard still refuses every API call on a closed
door, so failing open costs an empty shell; failing closed would take every
tenant's panel down with auth-service.

**Cached per host for 30 s**, bounded at 500 hosts like the brand cache: the
proxy runs on every non-static path, prefetches included. A domain verifying
or dropping back to `pending` reaches the page within that window; the API
refuses from the moment the gate flips.
