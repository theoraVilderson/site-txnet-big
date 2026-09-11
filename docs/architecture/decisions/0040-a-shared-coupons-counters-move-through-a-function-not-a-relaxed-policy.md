---
id: adr-0040
status: accepted
updated: 2026-09-11
---

# ADR 0040 — A shared coupon's counters move through a function, not a relaxed policy

- **Status:** accepted
- **Date:** 2026-09-11
- **Affects units:** billing

## Context

`billing.coupon` is shared-read (`20260909001500_row_level_security_all_tables`):
a tenant's connection reads its own coupons and the platform's (`tenantId`
NULL), and its `WITH CHECK` is strict, so it can never write a platform row.
That asymmetry is deliberate — writing the platform set would be privilege
escalation.

F-092-h has to write one: reserving a platform coupon bumps its
`reservedCount`, and confirming bumps `usedCount`. Under the policy as it is,
the first reservation of a platform coupon fails. The service has no
cross-tenant pool (`billing/contract.md` "Request edge"), and should not get one
for this.

## Decision

1. **The counters move only through two `SECURITY DEFINER` functions** in
   migration `20260911000200_coupon_reservation`: `billing.reserve_coupon` and
   `billing.settle_coupon_redemptions`. They change `usedCount`,
   `reservedCount` and `coupon_redemption`, nothing else, and only for a coupon
   the bound tenant can see (`tenantId` NULL or its own). They refuse to run
   with no tenant bound. `EXECUTE` goes to `txnet_app` and is revoked from
   `PUBLIC`.
2. **The RLS policy on `coupon` is not changed.** A tenant still cannot update
   any column of a platform coupon directly.
3. **The functions' owner must bypass RLS.** FORCE ROW LEVEL SECURITY binds a
   table's owner, so an owner that is neither superuser nor `BYPASSRLS` would
   hit the same `WITH CHECK`. `prisma migrate` runs as the superuser
   (`scripts/db-login-roles.sh`); the migration asserts it and fails otherwise.
4. The capacity and per-user checks run under a row lock on the coupon, taken
   inside the function, so they cannot be raced (billing invariant 6).

Chosen by the user on 2026-09-11 over two others: F-092-h holding only a
tenant's own coupons (platform coupons a later row), and moving the counters to
a separate table with a writable policy.

## Consequences

- A tenant's code that reads a platform coupon's counters sees the truth; one
  that tries to write them must go through the functions. Both functions are
  plpgsql — reviewing them is reviewing a privilege, the same as a policy.
- If the migrator ever stops being a superuser, the migration fails on a fresh
  database; an existing database keeps functions owned by the old role. Moving
  the owner then needs a role with `BYPASSRLS` and a new ADR.
- Every other shared-read table (`product_category`, `service_plan`, `panel`,
  `notification_campaign`) has the same asymmetry. A tenant-side counter on any
  of them takes the same shape, not a relaxed policy.
- Reversing: drop both functions; platform coupons can then no longer be
  reserved.
