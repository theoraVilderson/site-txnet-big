---
id: adr-0020
status: accepted
updated: 2026-09-09
---

# ADR 0020 — A request resolves its tenant from the Host header

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** identity, tenant, auth-api, panel-web, marketing-web

## Context

The platform is multi-tenant in the schema (ADR-0001, schema-per-domain with a
`tenantId` on every owned row) and multi-tenant in the deployment — F-059 proved
a second deployment boots with its own cookie domain, CORS origin and default
language. It is **single-tenant in every request**: `RegisterService` looks up
`slug: 'platform_owner'` and writes every account there. Nothing maps an
incoming request to a tenant, so `user.tenantId` is a constant and F-059's
second half cannot be written.

`TenantDomain` already exists and is already shaped for this: `domainValue` is
`@unique` across the table, carries a `domainType` (subdomain vs custom domain),
a `verificationStatus` and a TXT `verificationToken` for proving ownership. The
white-label product promises each reseller their own domain, which means the
domain is the thing the user actually arrives on.

## Decision

We will resolve the tenant of a request **from its Host header, against
`TenantDomain.domainValue`**, and fall back to a per-deployment configured
default tenant when the host matches no row.

A verified `TenantDomain` is the only mapping consulted; an unverified custom
domain does not resolve. The resolved tenant is attached to the request once, at
the edge of the Nest application, and every downstream query is scoped by it —
`RegisterService` reads the resolved tenant instead of looking up
`platform_owner`. The fallback exists so a deployment that has no domain rows
yet (development, the platform's own origin, a fresh install) still serves a
tenant rather than failing, and so F-059's second deployment can name its tenant
in configuration.

## Consequences

- Positive: `TenantDomain` becomes load-bearing rather than decorative, and a
  reseller's custom domain works the day it is verified, with no deploy.
- Positive: one process can serve several tenants, which is what F-059 needs in
  order to test multi-tenancy rather than test two configurations.
- Positive: the fallback keeps development and the platform's own origin working
  without a domain row.
- Negative / accepted cost: a host lookup on every request. It is a single
  indexed read on a small, rarely-changing table and belongs in a cache, which
  then needs invalidating when a domain is verified or removed.
- Negative / accepted cost: the fallback is a footgun in production — a
  misconfigured host silently serves the default tenant instead of erroring.
  The fallback tenant must be configured explicitly, never defaulted to
  `platform_owner` in a deployment that serves resellers.
- Forecloses: one container per reseller as the tenancy mechanism; trusting a
  client-supplied tenant header.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Per-deployment config only (`TENANT_ID` in env) | simple and lookup-free, but white-label custom domains then need one container per reseller, and `TenantDomain` stays unused |
| An explicit header set by Traefik / auth-handler | centralises the logic in the gateway, but `auth-handler` has no Postgres connection today, and the header is forgeable by anything that reaches the backend without passing the gateway |

## Revisit trigger

A tenant needs to be resolvable from something that is not the host — an API
consumed by many tenants over one domain, or a mobile client that authenticates
before it has a host. That is an additional resolver, not a replacement.
