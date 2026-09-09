---
id: adr-0025
status: accepted
updated: 2026-09-09
---

# ADR 0025 — Tenant detection has no fallback

- **Status:** accepted
- **Date:** 2026-09-09
- **Supersedes:** ADR-0020
- **Affects units:** tenant, tenant-context, auth-api, panel-web, marketing-web, bot-app

## Context

ADR-0020 resolved a request's tenant from its Host header against
`tenant_domain`, falling back to a configured `DEFAULT_TENANT_SLUG` when no row
matched. It named the fallback as an accepted cost and a production footgun: it
cannot tell a misconfigured host from an unknown one.

The feature catalog had already decided otherwise, and the decision was not
available to the session that wrote ADR-0020 — catalog block 20.3 carries no
feature id, so `spec.py` could not print it and MODE: INGEST could not see it.
Read directly, correction **C-01** states the chain as *verified custom domain →
`X-Tenant-Id`, only on platform-staff tokens*, removes "platform subdomain" from
the chain entirely, and requires that an unknown or unverified host **"returns a
neutral 404 at the edge … must not reveal that a platform exists, and must never
fall back to a platform tenant"**. It further requires the `host → tenantId`
cache to be invalidated **explicitly** on creation, verification, standby
switchover and deletion, because *"a stale mapping after a domain switch is a
cross-tenant leak, not just a stale page"* — where ADR-0020 chose a 60-second
in-process TTL with no invalidation path.

A fallback is not a smaller version of correct detection. On a deployment
serving resellers it silently absorbs every misconfigured host into one tenant,
which is the exact failure this platform is being hardened against.

## Decision

**A request either resolves to a tenant or it is refused.**

1. The chain is: a **verified** `tenant_domain` row for the host; then
   `X-Tenant-Id`, honoured **only** on a platform-staff token. Nothing else.
2. `DEFAULT_TENANT_SLUG` is removed. There is no fallback tenant, in any
   environment.
3. An unknown or unverified host answers a **neutral 404 at the edge** — no
   branding, no hint that a platform exists, no platform tenant.
4. The `host → tenantId` cache moves to Redis and is invalidated **explicitly**
   on domain creation, verification, switchover and deletion. A TTL is a
   backstop, never the mechanism.
5. Development and the e2e suite seed a real `tenant_domain` row for the host
   they use, rather than relying on a fallback.

Point 5 is the one that changes existing work, and it is an improvement on its
own terms: today the e2e suite passes *because* it falls through to the default,
so it proves the fallback rather than the resolution. With a seeded row it
exercises what production does.

## Consequences

- Positive: a misconfigured host fails loudly at the edge instead of quietly
  serving another tenant's data.
- Positive: the platform stops being discoverable from an arbitrary hostname.
- Positive: a verified domain works the moment it is verified, because
  invalidation is explicit rather than a race with a TTL.
- Negative / accepted cost: a fresh install serves nothing until a
  `tenant_domain` row exists. Bootstrapping becomes a real step — `prisma/seed.js`
  must create the platform owner's domain row alongside the tenant and roles it
  already creates.
- Negative / accepted cost: dev, e2e and any local tooling need that row too. A
  missing row is now a 404 rather than a silent success, which is the point, but
  it will surprise someone once.
- Negative / accepted cost: a Redis round trip enters the resolution path, and
  the cache needs a writer — domain administration (F-018) becomes a
  prerequisite for onboarding rather than a convenience.
- Forecloses: `DEFAULT_TENANT_SLUG`; a single-tenant deployment that never
  configures a domain; resolving a tenant from anything a client can set.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep ADR-0020's fallback and overrule C-01 | cheapest, and leaves dev and e2e untouched — but it keeps the footgun ADR-0020 itself flagged, and the spec calls a wrong fallback a cross-tenant leak. Overruling the product spec needs a better reason than the cost of seeding one row |
| A dev/test-only fallback, forbidden in production config | preserves the current suite and fails safe in production, but leaves two resolution paths, so what the tests exercise is not what production runs — which is how the current gap was reached |
| Resolve from a client-supplied header generally | ADR-0020 already foreclosed this; a forgeable tenant is not a tenancy boundary. C-01's narrow exception (platform-staff tokens only) is retained precisely because it is not client-supplied |

## Revisit trigger

A tenant must be resolvable from something that is neither a host nor a
platform-staff token — a public API consumed by many tenants over one domain
(F-1301), or a mobile client authenticating before it has a host. That is an
additional entry in the chain, decided on its own evidence, never a fallback.
