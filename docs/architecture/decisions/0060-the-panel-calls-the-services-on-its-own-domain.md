---
id: adr-0060
status: accepted
updated: 2026-09-18
---

# ADR 0060 — The panel calls the services on its own domain

- **Status:** accepted 2026-09-18 with F-066-u (user)
- **Date:** 2026-09-18
- **Affects units:** panel-web, auth-api, realtime, tenant, billing
- **Amends:** the refresh-cookie `Domain` decision of 2026-09-05
  (`auth-api/contract.cookies.md`); the cross-origin call of the panel-web
  TL;DR (2026-09-05)

## Context

A request's tenant is the host it arrives on (ADR-0025). The panel called every
service at one origin fixed at build time, `NEXT_PUBLIC_API_ORIGIN =
https://api.<domain>`, so a reseller's customer on `ali-vpn.ir` or
`ali.<domain>` reached the backend *as the platform's host*: resolved to the
platform, and the refresh cookie was written for `.<domain>`, which a browser
refuses outright on a reseller's own domain and which, under the platform's
domain, reaches every reseller's `<slug>.<domain>` panel as well.

## Decision

1. **Same-origin `/api`.** The panel calls `/api/<service>` and the realtime
   path on the domain it was loaded from. No API origin exists in the build.
2. **Traefik routes it, on every host.** The routers of every service the panel
   calls (`/api/auth`, `/api/billing`, `/api/catalog`, `/api/notifications`,
   `/api/tenants*`, the realtime path) carry no `Host(...)` and priority 120,
   above the panel's own router. Not a Next.js proxy — the one removed
   2026-09-05 stays removed. `api.<domain>` keeps working for other callers.
3. **Any host reaches the panel.** A priority-1 `HostRegexp` router sends every
   other host to `site-pwa`, with no certresolver: a reseller's CDN holds the
   certificate and points a CNAME at the gateway (user, 2026-09-18). Which hosts
   *work* stays the tenant resolver's call — an unregistered one is a neutral
   404 from every service.
4. **The refresh cookie is host-only.** No `Domain`: the host that sets it is the
   host that reads it. Every write and clear also expires the old
   `Domain=.<DOMAIN_NAME>` cookie, which a browser would otherwise send first.
   The `device_id` cookie is host-only for new browsers; an old domain-wide one
   is left to lapse — a partition key, not a credential.
5. **The platform's panel host is a `tenant_domain` row** (`panel.<domain>`,
   seeded next to `api.<domain>`).
6. **Each reseller gets its own CNAME target, `<slug>.edge.<domain>`** — *amended
   by ADR-0063: it is the reseller's only platform host and serves nothing; a CDN
   must keep the visitor's host* (user,
   2026-09-18), created with the reseller as a `panel` subdomain row. The
   reseller CNAMEs its custom domain there. A CDN that keeps the visitor's host
   resolves by the custom domain; one that forwards the target instead still
   sends a host that names the tenant — a single shared target would name
   none. `edge` is a reserved slug. A target is never a place a person is sent
   (`isCnameTarget`, shared-core): billing's return address skips it.

## Alternatives

| Option | Why not |
|---|---|
| `api.<reseller-domain>` per reseller | a second DNS record and CORS origin per domain, and a cookie that is still cross-site |
| A Next.js route proxying `/api` | the intermittent 502 the 2026-09-05 removal was about, and a hop Traefik already makes |
| Keep one origin, name the tenant in a header | a client-chosen tenant (ADR-0020 forecloses it), and the cookie problem stays |

## Consequences

- No CORS on the panel's path; `FRONTEND_ORIGIN` now matters only to a caller
  that is really cross-origin.
- A reseller's domain works the day its row is `verified` — no deploy, no
  Traefik change. How it becomes verified (a TXT record, then an http + https
  request answered through the CDN) is F-018-i.
- Behind a CDN the client address is the CDN's; `trust proxy` and IP rate
  limits read `X-Forwarded-For` as before. A CDN that rewrites `Host` to the
  CNAME target still resolves, by (6).
- DNS: one wildcard record, `*.edge.<domain>`, pointing at the gateway.
- Nobody is signed out by the switch: the old domain-wide cookie still reaches
  `panel.<domain>`, its first refresh answers with the host-only replacement,
  and the same response expires the old one.

## Revisit trigger

A caller that must reach a tenant's API from a different origin than its panel
(a native app, a third-party integration) — that is a CORS decision of its own.
