---
id: adr-0053
status: accepted
updated: 2026-09-17
---

# ADR 0053 — An admin surface picks its pool by the caller

- **Status:** accepted 2026-09-17 (row F-035-c, reopened)
- **Date:** 2026-09-17
- **Affects units:** notification, tenant-context; billing (follow-up row)

## Context

`notification_campaign` has shape-B RLS: a tenant's connection reads its own
and platform-wide rows and writes only its own. The platform owner must write
platform-wide rows (`tenantId NULL`) and rows for any tenant, which that policy
refuses on the app pool. F-035-c first shipped (5853f9a) with every campaign
query on the cross-tenant pool, as billing's coupon management does. That left
a reseller's isolation resting on one service-side `where` alone, with RLS
standing behind nobody.

## Decision

On an admin surface over a shape-B RLS table, the pool follows the caller:

- **A tenant admin (not the platform owner) → the normal connection, guard
  active.** Their queries run on the app pool, bound to their tenant by
  `withTenant`, so RLS refuses what the service filter might miss.
- **The platform owner → the special connection.** Only they are served on the
  cross-tenant pool. They may manage every row anyway, so RLS has nothing to
  withhold from them.

The owner/not-owner decision lives in one method (`access()` in
`campaign-admin.service.ts`), and a spec asserts that a non-owner call never
touches the cross-tenant pool. A model served this way is listed in
`TENANT_SCOPED_MODELS`; without it the app pool binds no tenant and RLS refuses
the write.

## Consequences

- Positive: resellers, who are many and less trusted, keep two layers — the
  service filter and RLS.
- Negative / accepted cost: two code paths per method (`tenantTransaction` for
  a tenant list, `$transaction` on the cross-tenant pool for the owner), and a
  spec fake per pool.
- What this forecloses: injecting the cross-tenant pool as the only pool of an
  admin service that tenant admins reach. Billing's coupon, gateway, catalog and
  settlement surfaces do so today; auditing them is its own row.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A — everything on the cross-tenant pool (the first ship, coupons today) | a reseller's isolation is one `where`; the user's call 2026-09-17 |
| B — relax the RLS policy so the owner may write `tenantId NULL` | contradicts ADR-0040 ("not a relaxed policy"), and incomplete: the owner drafting for another tenant still fails `WITH CHECK` |

## Revisit trigger

If a surface needs the owner's reach for a non-owner caller (a fan-out job, a
webhook), it is a service path, not an admin one — decide it in that row.
