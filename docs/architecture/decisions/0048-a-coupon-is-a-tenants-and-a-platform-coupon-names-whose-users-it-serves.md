---
id: adr-0048
status: accepted
updated: 2026-09-14
---

# ADR 0048 — A coupon is a tenant's, and a platform coupon names whose users it serves

- **Status:** accepted 2026-09-14 (rows F-502-a, F-502-b)
- **Date:** 2026-09-14
- **Affects units:** billing

## Context

D-33 opened coupon management. Until then `coupon.tenantId IS NULL` meant a
**platform-wide** coupon: `billing.coupon`'s RLS read side was `NULL OR mine`
(`20260909001500_row_level_security_all_tables`), so every tenant's users could
use it, and `coupon.code` was unique across the whole platform.

The user's calls in D-33 contradict all three:

- the platform owner makes coupons for **its own users**, for **the users of
  tenants it picks**, and for resellers' own accounts — never for everyone by
  default;
- a platform coupon applies **only on a platform gateway** — its discount is
  the platform's money, and a reseller's gateway collects the reseller's;
- a code is unique **inside a tenant**, so two resellers may both sell `NOWRUZ`.

## Decision

1. **A code is unique inside its tenant while the coupon is not deleted.** Two
   partial unique indexes: `(tenantId, code)` for a tenant's coupons, `(code)`
   for platform coupons. A soft-deleted coupon frees its code.
2. **`tenantId IS NULL` still means a platform coupon, but it serves only the
   tenants its `billing.coupon_tenant` rows name; with no row, only the platform
   owner's own users.** Existing platform coupons get no rows: from this
   migration on they serve the platform owner's users only. No backfill naming
   every tenant — decision 4 would refuse such a coupon on every reseller
   gateway anyway.
3. **The RLS read side is `mine OR (NULL AND billing.platform_coupon_serves(id,
   me))`.** A `SECURITY DEFINER` function answers the one boolean, because the
   policy would otherwise read `coupon_tenant` and `tenant.tenant` under the
   caller's own RLS. `WITH CHECK` stays strict: a tenant still cannot write a
   platform coupon (ADR-0040). `reserve_coupon` and `redeem_gift_coupon` bypass
   RLS as their owner, so they call the same function (F-502-b).
4. **A platform coupon on a tenant's own gateway (`tenant_gateway_config`) is
   refused with its own reason** (F-502-b). A granted platform gateway
   (ADR-0041) is a platform gateway.
5. **When a tenant's own coupon and a platform coupon serving it share a code,
   the tenant's own wins.** The user typed a code their tenant published; the
   platform's is reachable under another code (F-502-b).
6. **Delete is soft once anything redeemed a coupon** (`deletedAt`,
   `deletedByAdminId`, a CHECK that they come together). A soft-deleted coupon
   is `not_found` to a user and stays readable for its receipts.
7. **Gift codes generated together are a `coupon_batch`**, `tenantId` NULL for
   the platform owner's. It reads under strict RLS; a platform batch is reached
   on the cross-tenant pool, as settlement is.
8. **`coupon.manage`** is granted to `Admin` as `gateway.manage` is (D-31): the
   permission lets a tenant manage its own; the service, not the permission,
   keeps platform coupons and other tenants' for the platform owner (F-502-c).

## Consequences

- A reseller's users lose any platform coupon they could use before, unless the
  platform owner names their tenant. Accepted by D-33.
- A coupon lookup by code may now see two rows (decision 5); every reader must
  order by "mine first" rather than assume one.
- The platform owner's coupon for a reseller's **own account** is a `targeted`
  coupon of the platform tenant, valid only if that account lives in the
  platform tenant — checked at F-502-b's start.
