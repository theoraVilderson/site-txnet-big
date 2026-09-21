---
id: adr-0076
status: active
updated: 2026-09-21
---

# ADR 0076 — tax is charged on a top-up, at a rate a gateway may override

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** billing, tenant, panel-web
- **Supersedes:** [ADR-0038](0038-tax-is-charged-on-a-sale-never-on-a-top-up.md)

## Context

ADR-0038 (D-23, the user's call on 2026-09-11) removed tax from the top-up
path: a top-up sells nothing, so tax belongs to the sale that spends the
credit. It dropped `taxRatePercent` from `payment_gateway` and
`tenant_gateway_config` and `taxApplied` from `payment_transaction`, in
migration `20260911000100_no_tax_on_top_up`.

Its reasoning about *what a top-up is* still holds. What changed is the sale.

ADR-0038 wrote down the problem it was deferring, in its own Consequences:

> **Rounding under pay-as-you-go.** Tax on a period's total, rounded once.
> Rounding each tiny usage charge up to a cent overcharges, by up to one cent
> per charge.

At the time pay-as-you-go did not exist, so that was a note about a future
path. **ADR-0072 has made it concrete and much worse than the note assumed.**
A metered sale is no longer a periodic charge that could be totalled and taxed
once — it is a **block bought at a whole-cent price, many times a day, per
config**. Taxing the sale now means:

- hundreds of taxable events per user per day, each needing its own tax
  component;
- a tax figure on a 4c block that is a fraction of a cent, which
  `WalletLedgerService` refuses outright (`C-02`, ADR-0019) and never rounds;
- and no natural period to total over, because the block cadence follows the
  user's speed, not a calendar.

There is no arrangement of tax-on-sale that survives ADR-0072 without either
breaking `C-02` or inventing a second, `Micro`-denominated ledger — which is
the thing ADR-0072 was specifically able to avoid.

Meanwhile the shape the user asked for already exists in this codebase.
`depositPresets` is a two-level setting: a per-tenant default in
`billing.deposit_setting`, overridden per gateway, with empty meaning inherit —
and one calculator (`payment/pricing/gateway-pricing.ts`) reads both
`payment_gateway` and `tenant_gateway_config` through the same shape.

## Decision

**Tax is charged on a wallet top-up.** The user's call, 2026-09-21.

**The rate is resolved at two levels**, exactly as `depositPresets` already is:

```
gateway.taxRatePercent   (null = inherit)
   ↓
deposit_setting.taxRatePercent  (the tenant's default; null = no tax)
```

The override lives on both `payment_gateway` and `tenant_gateway_config`, so a
platform gateway and a reseller's own gateway are configured the same way and
read by the same calculator.

**Tax is added on top, never taken out.** The existing pricing already works
this way for the fee — `payable = basis + fee`, `credited = amount + gap` — and
tax joins it: **`payable = basis + fee + tax`, and `credited` is unchanged.** A
user who asks for 100 of credit receives 100 of credit and is charged
100 + fee + tax. The alternative, taking tax out of what arrives, means asking
for 100 and receiving 91.74, which no top-up page can explain.

**Tax rounds to the nearest cent, not up.** This differs deliberately from the
fee, which is `centsUp` (F-0609). A fee is our revenue and rounding it up costs
the payer a fraction they agreed to; **tax is collected to be remitted**, and
systematically over-collecting it creates a liability that has to be reconciled
against what is actually owed. One rounding, at the end, half-up.

**The free path carries no tax**, exactly as it carries no fee: a top-up that
coupons reduce to zero reaches no gateway, so there is nothing to tax.

`taxApplied` returns to `payment_transaction` as the record of what was
actually charged, and the rate is stored with it — a later rate change must not
re-explain an old receipt.

## Consequences

- Positive: **one taxable event per real movement of real money**, at the only
  point where an external receipt exists to reconcile against. Pay-as-you-go
  block purchases are ordinary wallet debits with no tax component at all.
- Positive: `C-02` is untouched. No sub-cent tax figure is ever computed,
  because tax is applied to a top-up amount, not to a 4c block.
- Positive: the two-level resolution is a pattern the panel, the API and the
  calculator already implement for presets, so the surfaces are familiar and
  the calculator gains one term rather than a new concept.
- Positive: per-gateway override is genuinely needed, not just convenient —
  gateways sit in different jurisdictions and currencies, and a crypto gateway
  and a domestic card gateway are not taxed alike.
- Negative / accepted cost: **this is legally correct only while the wallet is
  effectively single-purpose** — credit that buys this platform's services at a
  known tax treatment. Under most VAT regimes that makes it a single-purpose
  voucher, taxable at issue. If credit ever buys things at different rates, the
  right point moves back to the sale. That is this ADR's revisit trigger and it
  is not a small one.
- Negative / accepted cost: **credit is taxed at the rate in force when it was
  bought**, not when it is spent. A rate change does not reach money already in
  a wallet, which is the correct behaviour for a voucher and a surprising one
  for anyone expecting the sale to decide.
- Negative / accepted cost: **a refund must unwind tax that was already
  collected**, and possibly already remitted. Refunding a partially spent
  balance needs a rule this ADR does not set.
- Negative / accepted cost: it reverses a migration that is ten days old.
  ADR-0038 said reversal is cheap only while no payment has been recorded —
  that window is the thing to check before F-104-ae runs.
- What this forecloses: taxing a purchase or a usage charge anywhere. There is
  exactly one taxable event in the platform, and it is the top-up.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep ADR-0038 — tax the sale | it cannot survive ADR-0072. A metered sale is a 4c block bought many times a day; the tax on one is a fraction of a cent, which the ledger refuses and never rounds. ADR-0038 anticipated the rounding problem and the block model made it structural |
| Tax the sale, totalled over a period and charged once | there is no natural period — block cadence follows the user's line speed, not a calendar — and it reintroduces a running untaxed balance that has to be settled, which is the post-paid shape ADR-0072 removed |
| Tax both, netting at the sale | two taxable events per unit of money, with a reconciliation between them that exists only to undo the first |
| Tax-inclusive: take tax out of what arrives | a user asking for 100 receives 91.74. It is defensible accounting and an indefensible top-up page |
| One platform-wide rate, no override | gateways sit in different jurisdictions and currencies; a single rate is wrong for at least one of them from the first day a second gateway exists |
| Round tax up, like the fee | over-collects tax systematically. A fee rounded up is revenue; tax rounded up is a liability to somebody else |

## Revisit trigger

Any of:

- **The wallet stops being single-purpose** — credit becomes spendable on
  things with different tax treatment. That moves the correct taxable event
  back to the sale, and this decision would have to be reversed again with an
  accountant in the room.
- A refund rule is needed for a partially spent, already-taxed balance.
- An accountant reviews the treatment. ADR-0038 said this question should be
  asked of one, and it still has not been.
