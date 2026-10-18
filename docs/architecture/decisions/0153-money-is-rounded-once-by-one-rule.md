---
id: adr-0153
status: active
updated: 2026-10-18
---

# ADR 0153 — Money is rounded once, to its currency's decimals, by one rule

- **Status:** accepted
- **Date:** 2026-10-18
- **Decision:** the user's (2026-10-18: "so nobody's due is eaten and we take
  no loss, and everything comes out right, for the long run"; both
  recommended options: round by intent at the write, widen the columns now,
  before production)
- **Affects units:** billing (every path that writes money), currency (the
  registry's `decimalPlaces`), catalog, tenant, entitlement (their money columns)

## Context

Every money column is `DECIMAL(18,2)`, and Postgres rounds anything past two
places silently on write. No rule said which way a computed amount rounds:
20 files under `billing-service`, `shared-core` and the workers chose for
themselves, and 11 defined their own `2`. Most chose well. A tenant's
currency change did not: a balance worth under half a minor unit of the new
currency (1,000 IRR into USD is 0.00095) rounded to zero, its closing ledger
row had no opening row, and the owner's money left the books unrecorded.
`convertedByChanges` had already met the same hole for late credits
(contract.currency-change rule 6a) and fixed it there alone.

Holding more places in a balance was weighed and refused: money moves only in
real minor units — no gateway charges, and no owner withdraws, 0.0038 USD —
so the rounding is only deferred, a balance shows 0.00 while holding money
that can be neither spent nor paid out, and the figures a page sums stop
matching the stored ones.

## Decision

1. **Computed whole, rounded once, at the write**, to the row currency's
   `currency.decimalPlaces` — never a literal `2`. Converted more than once
   (IRR -> EUR -> USD), the rates are multiplied and the source amount is
   rounded once.
2. **The direction is set by who would bear the error:**
   - charged to the payer, in the gateway's minor unit: **up**;
   - credited to a wallet from what arrived: **down** — a fraction that did
     not arrive is not credited;
   - a hold, and what a cap has counted: **down** — free balance never goes
     negative, an owner's room never shrinks;
   - a price, a converted balance or setting: **half up**.
3. **A positive amount never rounds to nothing**: it is one minor unit. The
   platform carries the difference, at most half a unit, once.
4. **Parts sum to their whole**: the whole is rounded, the last part is the
   whole minus the others (fee + tax + net, gross - refunds).
5. **Precision lives in rates and unit prices**, not balances: a rate is
   `DECIMAL(30,18)`, a metered unit price `DECIMAL(18,8)`; usage accrues at
   that precision and is rounded once, when it is debited.
6. **The columns hold four places** (`DECIMAL(20,4)`), so a currency of three
   (KWD, BHD, OMR) can be registered; a row still holds only its currency's
   own. A currency whose `decimalPlaces` exceeds the column's scale is refused
   at registration. Done before production, while the tables are near empty.
7. **One home**: the rounding functions are named for their intent
   (charge, credit, hold, convert, split) in one `shared-core` module, and
   `conventions.py` refuses money rounded by hand outside it.

## Consequences

- Point 3 for a tenant's currency change landed with this ADR (F-116-o); the
  module and the check (F-116-p) and the columns (F-116-q) are rows of their
  own, in that order.
- The platform pays for point 3 in sub-cent units, bounded per wallet per
  change; a payer pays at most one gateway minor unit more for point 2.
- A new money path cannot pick its own rounding once F-116-p lands; until
  then, review holds it to this ADR.
