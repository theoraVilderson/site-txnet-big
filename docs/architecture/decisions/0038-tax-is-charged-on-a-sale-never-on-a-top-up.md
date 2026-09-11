---
id: adr-0038
status: accepted
updated: 2026-09-11
---

# ADR 0038 — Tax is charged on a sale, never on a wallet top-up

- **Status:** accepted
- **Date:** 2026-09-11
- **Affects units:** billing, tenant

## Context

The legacy app added a per-gateway `taxRate` to every wallet top-up, and
F-092-d carried it over as `taxRatePercent` on `payment_gateway` and
`tenant_gateway_config`, plus `taxApplied` on `payment_transaction`. F-092-e
built the calculator with that tax in it.

A top-up does not sell anything. It moves the user's money into their wallet
before any service is chosen. The platform sells when that credit buys a
service — a plan purchase or a pay-as-you-go usage charge. Taxing the top-up and
then the purchase would tax the same money twice. Taxing only the top-up would
tax credit that may never be spent, and a refund would have to unwind tax on a
sale that never happened.

## Decision

1. **A top-up carries no tax.** The user pays the amount after coupons and gap,
   plus the gateway fee, and nothing else. `priceAtGateway` returns no tax.
2. The gateway fee is charged only when something reaches the gateway: a top-up
   that coupons reduce to zero is free, with no fee (unchanged from F-092-e).
3. **Tax is charged when a service is sold**, by the purchase and usage paths.
   Those paths are not built, and neither is the tax rule. This ADR fixes
   *where*, not *how much* or *on which base*.
4. `taxRatePercent` leaves both gateway tables and `taxApplied` leaves
   `payment_transaction` — migration `20260911000100_no_tax_on_top_up`. A tax
   rate is not a property of a payment gateway.

Decided by the user on 2026-09-11 (D-23), right after F-092-e shipped.

## Consequences

- One less number between the quote and the charge. The panel's top-up summary
  (F-093-e) and its payment history (F-093-d) show no tax line.
- The row that builds purchase or pay-as-you-go must answer, and should ask an
  accountant, two questions this ADR leaves open:
  - **Rounding under pay-as-you-go.** Tax on a period's total, rounded once.
    Rounding each tiny usage charge up to a cent overcharges, by up to one cent
    per charge.
  - **The tax base when credit came from a coupon.** A top-up of 100 paid with
    80 buys 100 of credit. Whether a later 100 purchase is taxed on 100 or on
    80 decides whether the ledger must tell paid credit from promotional credit.
- Reversing this means adding the columns back and taxing a top-up again. That
  is cheap only while no payment has been recorded.
