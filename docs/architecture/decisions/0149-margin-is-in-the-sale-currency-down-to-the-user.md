---
id: adr-0149
status: active
updated: 2026-10-16
---

# ADR 0149 — Margin is in the sale's currency, down to the user

- **Status:** accepted
- **Date:** 2026-10-16
- **Decision:** the user's (2026-10-16, asked at the start of F-1001-l, F-1003
  and F-1004-a; each answer the recommended one)
- **Affects units:** billing (the cost rollup, the margin and cohort reads, the
  loss alert), panel-web (`/analytics` Profit and Cohorts)
- **Amends:** billing `contract.analytics.md` principle 6 (for cost only) and
  `contract.analytics-tabs.md` "Cost attribution" rule 3.

## Context

F-1002-b wrote every cost in the currency it was incurred in: a platform panel
in USD (network `contract.panel-cost.md`), a reseller's payments to the
platform in its billing wallet's currency. Sales are in the tenant's operating
currency — the toman on the platform today. Principle 6 ("nothing is
converted") then makes the platform's own margin a toman figure minus a dollar
one: not computable. And a reseller's cost stopped at the product, so neither
a user's margin nor F-1003 ("this user costs more than they pay") could be
answered for any reseller.

## Decision

1. **A cost is converted at its own day's rate** into the tenant's operating
   currency as the pass that writes it runs, and stored beside the original
   (`analytics_cost_day.saleCurrencyCode`, `saleCost`). The rate is the one in
   force at the end of that day, read as `readFxRate` reads today's: a live pin
   (the tenant's own first), else the newest discovered rate; the toman as the
   rial over ten. A rate changing today never rewrites last month.
2. **No rate is not zero.** A cost no rate converts keeps `saleCost` null and
   is answered in its own currency, beside the sale — never summed into it.
3. **A reseller's wholesale cost is split to its users and panels**, by the
   same bytes that split it per product. They are its own people, so ADR-0104
   is untouched; the platform's rows still name a reseller's Grant by tenant only.
4. **F-1003's threshold is a percentage** of the user's 30-day net, 0–500,
   default 20 — a currency change cannot break it. A user who paid nothing and
   cost something is over any threshold, told once a month.
5. **A cohort's channel is the signup source** (`web`, a bot platform,
   `unknown`) until a deep link or campaign is recorded at signup; that is a
   row of its own, and it adds a value to the same column.

## Rejected

- **Margin only where the currencies match**: cheap, but the platform's own
  margin would always be empty and the conversion would be built later anyway.
- **Converting at today's rate on read**: one moving rate restates every past
  month, and a three-year window would read three years of rates per request.
- **A fixed-amount threshold**: tied to one currency, so a currency change or
  a reseller in another currency needs it set again.

## Consequences

- Every tenant is rebuilt once (migration `20261016000500`).
- A currency change (F-116) leaves earlier cost rows in the currency they were
  converted into, as earlier sales stay in theirs; a later whole rebuild
  converts them all into the new one.
