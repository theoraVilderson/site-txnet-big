---
id: adr-0099
status: accepted
updated: 2026-09-28
---

# ADR 0099 — a platform coupon serves no reseller's users

- **Status:** accepted
- **Date:** 2026-09-28 (row F-116-h7)
- **Affects units:** billing, panel-web
- **Supersedes:** [ADR-0048](0048-a-coupon-is-a-tenants-and-a-platform-coupon-names-whose-users-it-serves.md) decision 2 only

## Context

ADR-0048 decision 2 let the platform owner name reseller tenants on a platform
coupon or gift code (`billing.coupon_tenant`), and their users could then use
it. Decision 4 kept the platform's discount off a reseller's own gateway, so the
platform never gave away a reseller's money.

That gate only covers a top-up. An invoice paid from the wallet (F-111-b) goes
through no gateway, so a named reseller's user could take a platform discount
out of the reseller's own sale. The same was true of a lent platform gateway and
of the gift-code box.

The user's call (2026-09-28): a reseller's users see the reseller's brand, not
the platform's. A platform coupon or gift code is not theirs, whatever the
gateway or the target.

## Decision

1. **A platform coupon (`tenantId IS NULL`) serves the platform owner's users
   and no other tenant's.** `billing.platform_coupon_serves` answers `true` only
   for the `platform_owner` tenant. The coupon RLS read side, `reserve_coupon`
   and `redeem_gift_coupon` all ask that function, so one change covers
   validation, reservation and the gift box. A reseller's user who types a
   platform code gets `not_found`, the same answer as a code that does not exist.
2. **`billing.coupon_tenant` is dropped, and with it `tenantIds`** on coupon
   create/update and on a gift batch. The admin API's strict schemas refuse the
   field (`400`) rather than ignore it. The `tenants_are_platform_coupons`
   refusal and the panel's "tenants" field go with it.
3. **A reseller's own account is unaffected.** It lives in the platform tenant
   (ADR-0048 consequences), so the platform's coupons still serve it.

## Consequences

- Nothing is paid for twice and nothing needs settling: no platform discount
  ever lands on a reseller's sale, so there is no platform-funded discount to
  owe back.
- ADR-0048 decision 4 (`platform_coupon_needs_platform_gateway`) still stands.
  It now only ever meets the platform owner's own payers.
- The open question on a platform coupon in a reseller's other currency is
  closed: that case can no longer happen.
- If the platform later wants to run a campaign for resellers' users, that is a
  new decision. It needs a way to fund the discount (a settlement entry the
  platform owes), not a return of `coupon_tenant`.
