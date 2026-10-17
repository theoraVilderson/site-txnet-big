---
id: adr-0152
status: active
updated: 2026-10-17
---

# ADR 0152 — Analytics answers in the tenant's currency now, each figure at its own day's rate

- **Status:** accepted
- **Date:** 2026-10-17
- **Decision:** the user's (2026-10-17: "instead of two currencies, show it in
  the main currency — and the total must not come out wrong"; both
  recommended options: the page's own currency, each day's rate)
- **Affects units:** billing (the rollup, the cross-tenant reads), panel-web
  (the analytics page shows one currency)
- **Reverses:** billing `contract.analytics.md` principle 6 ("a sum never
  crosses currencies … nothing is converted here — except cost"). **Supersedes**
  the per-sale and per-instant cost currencies of F-1001-q / F-1001-r.

## Context

Principle 6 kept every money row in the currency it was taken in, so a tenant
that changed currency (F-116) saw its analytics split in two: a live test on
dev (2026-10-17) left the platform with USD 4,580.70 beside EUR 3.57, and a
reseller with dollars beside tomans. Nothing was wrong, but nothing could be
read either: no total, no margin rate across the change, a "new" delta on
every KPI. Cost was already converted at its own day's rate (ADR-0149); sales
were not, so cost and sales could only be matched per currency, which is what
F-1001-q and F-1001-r spent their effort on.

## Decision

1. **One currency per page: the tenant's operating currency now.** The
   platform's analytics in the platform's, a reseller's in its own. A
   reseller is never shown its sales in the platform's money.
2. **Each figure converted at its own day's rate** — the rate in force at the
   end of the tenant day it happened (`readRates`: a live pin, the tenant's
   first, over the newest discovered rate; the toman as the rial over ten),
   so a later swing never rewrites last year. Summed only after converting,
   and rounded once, at the sum.
3. **Converted when the rollup is written.** Every flow row — sales, users,
   payments, cost — is written in the operating currency, so every reader
   (tabs, export, reports, the loss alert) reads one currency and stays as it
   was. The ledger is untouched: each row keeps the money it was taken in.
4. **A currency change rebuilds.** `analytics_rollup_state.currencyCode` is
   the currency the rows were written in; a tenant whose operating currency
   differs is rebuilt whole by the next tick, as a zone change is (principle 5).
5. **No rate, no guess.** A day with no rate on record takes the newest one
   before it (point 2 already). An amount with no rate at all stays in its own
   currency and the page shows it apart, under the notice it already has — it
   is never summed in.
6. **The platform reads its resellers in its own money.** The Resellers tab
   and the margin's `resellers` read each reseller's rows (in that reseller's
   currency) per day and convert them at that day's rate before summing.

## Consequences

- One total and one margin rate across a currency change; a KPI's previous
  period compares like with like.
- A currency change costs a rebuild of that tenant's history (minutes for a
  large tenant), during which the page says "rebuilding".
- What a sale was in its own currency is no longer in analytics; the ledger,
  the wallet history and `/revenue` still have it.
- F-1001-q / F-1001-r's per-sale and per-instant cost currencies, and the
  `currency_change` read behind them, are deleted (C-21): with one currency
  there is nothing to match.
