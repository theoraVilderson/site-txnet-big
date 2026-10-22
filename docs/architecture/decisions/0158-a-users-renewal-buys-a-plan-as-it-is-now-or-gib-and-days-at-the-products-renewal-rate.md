---
id: adr-0158
status: active
updated: 2026-10-22
---

# ADR 0158 — A user's renewal buys a plan as it is now, or GiB and days at the product's renewal rate

- **Status:** accepted
- **Date:** 2026-10-22
- **Decision:** the user's (2026-10-20, recorded by F-305-a); the money shape
  (points 4–7) follows ADR-0098, ADR-0151 and ADR-0153 without a new choice
- **Affects units:** billing (the renewal invoice and its payment, F-305-c/d/e),
  catalog (`renewal_rate`, F-305-b), entitlement (`renewGrant`, unchanged),
  panel-web (the renewal sheet, F-305-f/g), bot-app (F-305-i)

## Context

A user could buy a Grant (F-111) but not extend one: the only renewal was an
admin's (F-311-d), with no money in it. F-305 asks for a renewal and a top-up
on the **same** Grant, paid from the wallet. Three questions decide how much
code it needs, and none can be answered by the code alone: what a renewal
costs and adds when the catalog has changed since the purchase; whether the
user may change plan on the way; and what prices a renewal that matches no
plan. The admin's renewal copies the Grant's own bag and period, "never the
variant as edited since" (entitlement invariant 27). A user is paying,
so the price has to come from the catalog as it is today. The bag has to
come with it, or the user pays today's price for an old bag.

## Decision

1. **A plan renewal buys the plan as it is now**: the variant's bag, days and
   price in effect at the invoice, not the Grant's copy from its issue. It is
   handed to `renewGrant` as a typed amount (`{bytes, days}`), so debt
   forgiveness, the usage period and revival are `renewGrant`'s, unchanged.
2. **Renewable while the variant exists, is live and has a price in effect.**
   `admin_only`, `unlisted`, a full sales cap (F-513) or active cap (F-514)
   never refuse a renewal: those rules say who may *start* a service, and a
   renewal starts none. A renewal is never held or counted by either cap.
   The same reasoning covers a product's audience (PT-1-b), a reseller's
   package list (F-019-v5, which already exempts a renewal) and the limits
   on how many services or platform Grants a buyer may hold. The wholesale
   bag of a reseller's package plan is still bought (entitlement invariant 30).
3. **The user may switch plan within the product**: any other live, priced
   variant of the **same product** on the **Grant's own panel group**
   (entitlement invariant 31) and the same billing mode, larger or smaller.
   The Grant then carries the new variant, bag and period, so its next
   renewal is of that plan.
4. **Or GiB and days at the product's renewal rate.** A product may carry a
   `renewal_rate`: a price per GiB and a price per day, with the fewest and
   most GiB and days one renewal buys. `amount = gib × pricePerGib +
   days × pricePerDay`, rounded once up to the currency's minor unit
   (`roundCharge`, ADR-0153). A product with no rate in effect has **custom
   renewal off**.
5. **The rate is history, as a price is**: a change is a new row from
   `effectiveFrom`, never in the past, never edited. Switching custom renewal
   off is a row with no prices (ADR-0151's take-back). An invoice records the
   row it was priced at, so the rate it quoted is the rate it charges.
6. **The rate is in its tenant's operating currency**, read only in the
   reader's (catalog invariant 11). A currency change writes the rate in
   effect, and every one scheduled after it, again in the new money, as it
   does a price and a rate card. A reseller selling a platform product renews
   it at the platform's rate, or not at all when that rate is in another
   currency, as with a price.
7. **Discounts are a purchase's**: a renewal invoice is priced through the
   codeless rule and the coupons exactly as a purchase invoice
   (`contract.purchase.md`), on its own `amount`.
8. **Only a renewable Grant**: the caller's own, `active` or `suspended`
   for any reason. A metered Grant buys no GiB
   (its bytes are blocks, F-118), and a Grant whose plan has unlimited
   traffic or unlimited days is offered only the part that is limited.

## Consequences

- Positive: one invoice shape for buying and renewing. One renewal engine
  for the admin and the user (`renewGrant`). A seller who never sets a rate
  gets plan renewals only, and nothing breaks.
- Negative / accepted cost: a plan edited after a user bought it reaches
  that user at renewal, in bag and in price. A user on a plan the seller has
  made smaller gets the smaller bag at renewal. They see it on the renewal
  sheet before paying.
- The rate is the product's, not the variant's: one product's variants on
  two quality tiers share one price per GiB. A seller who needs two prices
  sells two products.
- What this forecloses: a renewal at the price the user first paid
  ("grandfathering"). Reopening it means a price stored on the Grant, which
  this ADR deliberately does not keep.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Renew at the Grant's own copy of bag and price (the admin's rule) | the price is gone from the catalog's history once replaced; a seller could never raise a renewal's price, and a campaign could never reach one |
| A new Grant per renewal | the debt, the usage period, the configs and the `/sub` link would all start again (entitlement invariant 16) |
| A rate on each variant | the user types GiB and days for the *service*, not for a SKU; a rate per variant would need choosing a variant first, which is the plan renewal |
| Reuse `rate_card` (F-118) | a rate card prices a meter's use on a variant, locked onto a Grant at sale; a renewal rate prices a one-time top-up of a product, read at the invoice. One table for both would make every reader ask which one it is |
| Free GiB or days at a rate of 0 | a part that is not sold is a bound of 0, which says so; a rate of 0 would be a gift through the shop |

## Revisit trigger

A seller asks for two renewal prices on one product (per quality tier or per
panel group), or for a renewal at the price first paid.
