---
id: adr-0065
status: accepted
updated: 2026-09-19
---

# ADR 0065 — A public route lives under one prefix per service

- **Status:** accepted 2026-09-19 with F-018-ak (user)
- **Date:** 2026-09-19
- **Affects units:** tenant, auth-api, panel-web, forward-auth, object-storage

## Context
A route nobody signs in to — the file route, the branding read, the domain
probe — cost three things each, written by hand: two Traefik routers without
`my-auth` (~12 labels), an entry in the service's `IdentityMiddleware`
exclusions, and its own code to name the tenant from the Host. The three were
different in each case and nothing checked them. Forgetting one gave a 401 on a
public page; forgetting the Host check gave an anonymous route with no tenant.

The panel's door question (`GET /api/auth/door`) lived in `auth-service`
only because `/api/auth` was the one prefix Traefik served on every host with
no gate. The question is about the tenant's domain, not about sign-in.

## Decision
We will serve every public route under `/api/public/<service>/`, and nowhere
else.

1. **Traefik:** one router pair per service for `PathPrefix(/api/public/<service>)`,
   with `strip-fake-headers` and no `my-auth`. It is written once, when the
   service gets its first public route, and never again per route.
2. **The service:** `public/*path` is excluded from the identity gate. One host
   middleware reads the `tenant_domain` row the Host proves (`surfaceOfHost`,
   shared-core), puts it on the request and opens that tenant's scope.
3. **The route:** declares its doors with `@PublicRoute({ doors })`: a list of
   purposes (never on a closed door, ADR-0063), `'any'` (answers on closed doors
   too) or `'none'` (the handler proves the request itself). `PublicRouteGuard`
   (shared-core) enforces it. A public request that reaches a handler with no
   `@PublicRoute` is a 404, so a forgotten decorator fails closed. A spec in
   each service checks that every handler under `public/` declares its doors.
4. **The door rules** (`doorClosed`, `doorServesPanel`) live in shared-core, so
   `auth-service`'s `TenantGuard` and the public routes refuse on one rule.

The door question moves to `GET /api/public/tenant/serves-panel`. The files,
branding and probe routes move to `/api/public/tenant/{files,branding,domain-probe}`.

Payment-gateway callbacks and webhooks (`/api/billing/deposit/...`) stay where
they are. Their URLs are registered with the gateway and are not ours to move.

## Consequences
- Positive: a new public route is one controller and one decorator. It gets
  no Traefik edit and no exclusion list. The Host rule and the door rule each
  have one copy.
- Positive: `grep -rn PublicRoute` lists every anonymous route in a service.
- Negative / accepted cost: the old paths answer for one more release (§8)
  through three deprecated routers and extra controller paths, to be removed by
  a later row.
- Negative / accepted cost: files and branding now refuse on a closed door
  (a reseller's legacy `<slug>.<domain>` platform subdomain). Before, they
  refused only the CNAME target. This matches ADR-0063, and `panelHostOf`
  already never hands such a host out.
- What this forecloses: a public route under a service's gated prefix
  (`/api/tenants/...`). That prefix goes through `my-auth`.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| Keep a router per route, generate the labels from a list | still an infrastructure edit per route, and each service still resolves the Host its own way |
| `/api/<service>/public/...` | overlaps the gated `PathPrefix(/api/<service>)` router and depends on priority to stay open |
| Leave the door question in `auth-service` | the question is the tenant's; it stayed there only for the routing |

## Revisit trigger
A public route that needs a session after all (optional sign-in), or a second
service with its own Host rule. Either one means the host middleware moves into
shared-core as a Nest provider instead of one copy per service.
