---
id: adr-0067
status: accepted
updated: 2026-09-20
---

# ADR 0067 — A reseller's revenue is what its users spent, gross, and it is not settlement

- **Status:** accepted 2026-09-20 with F-311-b (user)
- **Date:** 2026-09-20
- **Affects units:** billing, tenant, bot-app

## Context
F-311 asks for a "revenue report" in a reseller's bot panel. The row was split
on 2026-09-20 and F-311-b carried a `needs-decision`, because three ledgers in
this platform can each be called a reseller's revenue and no two of them answer
the same number:

| ledger | what it says | whose question |
|---|---|---|
| `payment_transaction` | what arrived through the reseller's gateways | the reseller's cash in |
| `wallet_transaction` | what its users spent | the reseller's sales |
| `gateway_settlement_entry` | what the platform owes for a borrowed gateway | the **platform owner's** (F-096-e) |

The third is the trap. `/api/billing/admin/settlement/*` already sums two
ledgers per tenant and is the only existing "money per tenant" surface, so it
reads like the thing to reuse. It is not: it answers what the platform owes a
tenant whose gateway collected money for it, which is a debt and not a sale, and
it is a platform-owner-only surface (invariant #9).

The first two differ in an ordinary case rather than an edge one. A user who
tops up 100 and spends 40 is 40 of revenue and 100 of cash in. Reporting either
one as "revenue" makes the other unavailable and is wrong half the time.

And the platform's own cut is nowhere in either. A reseller pays the platform
from `tenant_billing_wallet` (F-019-a/b) on its package's period —
`subscription_charge`, `metered_usage_charge` — which is a different ledger on a
different clock from the daily sales above.

## Decision
1. **Two figures, answered together, neither folded into the other.** `sales`
   is the total of this reseller's users' wallet **debits with a sale reason**;
   `topUps` is the total of its **settled** payments. The consumer decides
   which is the headline; the API refuses to decide it by naming one "revenue".
2. **Gross.** The platform's cut is not subtracted, because no row supports the
   subtraction: netting a monthly subscription charge against a day's sales
   would be an invented number that reconciles to nothing. What the platform
   charged is already readable on its own ledger (F-019-j), and adding it here
   later changes no arithmetic above.
3. **A sale is a debit with a sale reason, and the reasons are an exhaustive
   table.** `IS_SALE` in `reseller-revenue.service.ts` classifies every
   `WalletReasonType`, so a new one does not compile until somebody says whether
   a reseller earned money by it. Today exactly one qualifies:
   `traffic_consumption`.
4. **Settlement stays where it is.** F-096-e is not extended, re-scoped or
   reused. Two audiences, two numbers, two surfaces.

## Consequences
- **The sales figure is 0.00 until the `entitlement` unit is built.** Nothing
  writes `traffic_consumption` yet — `entitlement` is `draft` (F-026-b), which
  is also why F-311-d is blocked. The surface is complete and correct, and its
  headline number is empty. `topUps` is real today and is what F-311-c can show
  in the meantime; the bot screen must be built knowing this rather than
  discovering it.
- **`sub_account_charge` is deliberately excluded** — it funds a Config-scoped
  shared wallet, and the consumption charged out of that wallet is the
  `traffic_consumption` already counted. Counting both counts one sale twice.
  This is the entry most likely to need revisiting when `entitlement` lands, and
  the exhaustive table is what will put it in front of whoever does.
- **`wallet_transfer_out` is excluded**, which is a correctness rule and not a
  taste one: two of a reseller's users passing the same money back and forth
  would otherwise manufacture revenue in a loop.
- The window is capped at a year by the schema and the route has its own
  rate-limit bucket. Both aggregates scan the tenant's ledgers over the period
  with nothing narrowing them further, so this is the most expensive read on any
  reseller-named surface.
- Nothing is cached, on the same reasoning as ADR-0041 §5: the ledger says what
  was earned, and a stored total is a second memory that can disagree with it.

## Alternatives considered
- **One `revenue` number from `payment_transaction`.** Simplest, and the only
  one with data in it today — which is exactly why it is tempting and why it is
  wrong. It answers "how much was topped up", so every later question (margin,
  a package's performance, F-1531's daily summary) would be asked of a number
  that cannot answer it, and the rewrite would land after resellers had been
  reading it for months.
- **Extending `settlement` to answer both audiences.** Rejected on the long
  run. Its permission model is the platform owner's by construction (invariant
  #9, `assertOperator`), so a reseller-readable mode means a second door on a
  surface whose whole contract is that it has one.
- **Netting the platform's cut per sale.** Requires the cut to be knowable per
  sale, which the current model does not provide — and changing it is a
  re-architecture of tenant billing, not part of a reporting row.
