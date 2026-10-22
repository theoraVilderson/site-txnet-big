---
id: billing
layer: domain
status: active
version: 86
updated: 2026-10-22
---

# Contract — billing / renewing a Grant from the wallet (F-305, ADR-0158)

A topic file of `contract.md` (§10), beside [contract.purchase.md](contract.purchase.md):
a user extends a Grant they hold and pays for it from the wallet. The invoice, its
30-minute clock, its coupons and its payment are a purchase's. This file holds only
where a renewal differs. The admin's renewal (no money, F-311-d) is
[contract.reseller-grants.md](contract.reseller-grants.md). Both land in entitlement's
`renewGrant` (entitlement `contract.admin.md` "Renew").

**Status: decided, not built.** F-305-c (the invoice), F-305-d (paying it),
F-305-e (GiB and days) build what is below, over the product's renewal rate
that catalog stores (F-305-b).
Consumers: panel-web [contract.renewal.md](../../interfaces/panel-web/contract.renewal.md)
(F-305-f/g), bot-app (F-305-i).

## What may be renewed, and to what (F-305-c)

| # | Rule | Why |
|---|---|---|
| 1 | **Only the caller's own Grant**, `active` or `suspended`, whatever the reason it is suspended. Another user's, another tenant's or an unknown id is one neutral `404`; any other status is refused | the user's own service; a closed Grant has nothing to extend |
| 2 | **A plan renewal is the variant as it is now**: today's bag (`quotas.traffic_bytes`), `durationDays` and price in effect, passed to `renewGrant` as a typed amount. Never the Grant's copy from its issue | ADR-0158 (1): the price is today's, so the bag is too |
| 3 | **The plan may be the Grant's own or another of the same product**, on the Grant's own panel group (entitlement invariant 31) and the same billing mode. It may be larger or smaller. The Grant's own plan is offered first | ADR-0158 (3) |
| 4 | **Renewable while the variant exists, is live, and has a price in effect** in the tenant's currency. `admin_only`, `unlisted`, sold out (F-513) or a full active cap (F-514) never refuse it. Neither does a product's audience (PT-1-b) or a reseller's package list (F-019-v5). A renewal is never held or counted by a cap | ADR-0158 (2): these say who may start a service; a renewal starts none |
| 5 | **Or GiB and days typed** (F-305-e): `{gib, days}` priced by the product's renewal rate in effect, within its bounds. No rate in effect = custom renewal off for that product (`custom_renewal_off`). Out of bounds, or both 0, is refused | ADR-0158 (4) |
| 6 | **Only the limited part is sold**: a metered Grant buys no GiB (its bytes are blocks, F-118); a Grant with unlimited traffic buys days only, one with unlimited days GiB only | the part already unlimited has nothing to add |
| 7 | **Discounts as a purchase**: the codeless rule, then the coupons, on the renewal's `amount` ("Discounts with no code" and "Coupon validation") | ADR-0158 (7) |

## The money (F-305-c, F-305-e)

| # | Rule | Why |
|---|---|---|
| 8 | **The server prices it** (spec §5.8): a plan renewal at the variant's price in effect; a typed one at `gib × pricePerGib + days × pricePerDay`, rounded **once**, up, to the currency's minor unit (`roundCharge`, ADR-0153) | a price in the body is stripped, as on a purchase |
| 9 | **The invoice records what priced it**: the price row (`priceId`), or the renewal-rate row and the GiB and days typed. Paying charges what was quoted, even if a newer row took effect in between | a rate is history, as a price is (ADR-0158 (5)) |
| 10 | **In the tenant's operating currency.** A row in another currency is no rate (catalog invariant 11), so the plan or the custom renewal is not offered | as a price |

## Paying it (F-305-d)

| # | Rule | Why |
|---|---|---|
| 11 | **The purchase's transaction, with one step changed**: in place of issuing a Grant, `renewGrant` on the invoice's Grant, under its row lock. One `grant_renewal` row names the user as actor and the invoice as request | one request, one renewal (entitlement invariant 27) |
| 12 | **A plan switch writes the Grant's new variant, bag and period** in the same transaction. Its next renewal is of that plan | ADR-0158 (3) |
| 13 | **A reseller's package plan on a platform panel buys its bag wholesale** in the same transaction (entitlement invariant 30); a shortfall is the purchase's (`insufficient_balance` + `facts`, F-111-c) | the platform is paid for every byte it serves |
| 14 | **The page hears it**: the payment writes its outbox event (C-14, ADR-0121), and My services re-reads the Grant on it | no page polls for a renewal |
