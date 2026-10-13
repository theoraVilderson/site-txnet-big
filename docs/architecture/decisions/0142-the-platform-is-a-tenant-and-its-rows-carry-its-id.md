---
id: adr-0142
status: active
updated: 2026-10-13
---

# ADR 0142 — The platform is a tenant, and its rows carry its id

- **Status:** accepted (built by PT-1-a … PT-1-k)
- **Date:** 2026-10-13
- **Decision:** the user's (2026-10-13)
- **Affects units:** catalog, network, support, guide, billing, currency,
  notification, audit, identity, panel-web, bot-app
- **Supersedes:** every rule that reads "`tenantId` null is the platform's" —
  ADR-0049 (catalog ownership), ADR-0086 §3 (platform capabilities), ADR-0048 /
  ADR-0099 (platform coupons), ADR-0117 (platform guide files), as each
  domain's PT-1 row lands. Their other points stand.

## Context

The platform had two identities. Its **shared** rows (catalog, panels,
guides, coupons, SLA policies, …) carried `tenantId` null and were read by
every tenant through RLS's `"tenantId" IS NULL OR …`. Its **own** rows, made
by staff signed in to the `platform_owner` tenant, carried that tenant's id.
Every reader had to know both, and the ones that knew one were wrong.

The worked example, 2026-10-13: products the platform's staff created with the
wizard's default ("own") carried the `platform_owner` id, and the users page's
"issue a new service" listed only `tenantId` null, so none of them appeared.
Five products on dev, every product made from the panel since 2026-09-25.

## Decision

1. **Every row the platform owns carries the `platform_owner` tenant's id.**
   `tenantId` stops being nullable on those tables. There is exactly one
   `platform_owner` tenant (tenant invariant), so the id is known.
2. **One SQL function, `public.platform_tenant_id()`**, answers that id
   (STABLE, reads `tenant.tenant`). Shared-read RLS becomes
   `"tenantId" = public.current_tenant_id() OR "tenantId" = public.platform_tenant_id()`,
   and writes stay `"tenantId" = public.current_tenant_id()`, so the platform
   writes its rows as itself, not through `txnet_cross_tenant`.
3. **"Shared with resellers" is not a flag.** What a reseller *sees* of the
   platform is everything the platform owns, as before for null. What it may
   *sell* stays its package's list (F-019-v5, ADR-0107 point 3). The
   catalog wizard's "own / platform" choice collapses into one: the platform's.
4. **Who among the platform's users may buy a product is a separate
   decision**: a product's audience is every user (the default) or the user
   groups chosen on it. A Grant already sold is kept when its owner leaves the
   group; only new purchases close (PT-1-b).
5. **Domain by domain, one row each**, each with its own migration: backfill
   null to the platform's id, `NOT NULL`, the policy of point 2, partial unique
   indexes (`… WHERE "tenantId" IS NULL`) replaced by the plain
   `(tenantId, key)` one, and every `tenantId: null` / `=== null` in that
   domain's code. Catalog first (PT-1-a), because it holds the bug above.
6. **A null that means "no tenant at all" is not the platform.** A role
   template (ADR-0062) and an audit entry with no tenant are examined in their
   own rows and asked before they change.

## Consequences

- A reader asks one question — "this tenant's or the platform's" — with one id.
  The platform's own shop, the users page and a reseller's view agree.
- Every product the platform makes is visible to resellers' catalogs as the
  null ones were; selling it still needs the package to list it.
- Until a domain's row lands, that domain still uses null. Code crossing
  domains (a coupon naming a variant) must read both forms until both sides
  have moved.
- Not chosen: **keep null and teach every reader both ids** (the bug repeats
  with each new reader), and **a "shared" flag on each row** (a second
  identity under another name).
