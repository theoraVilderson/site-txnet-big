---
id: adr-0073
status: active
updated: 2026-09-21
---

# ADR 0073 — a metered rate is locked on the Grant at issue

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** catalog, entitlement, billing, network

## Context

ADR-0072 buys blocks of bytes at a price. Nothing in the catalog can express
that price. `catalog.Price` is per **variant** — `Decimal(18, 2)`, append-only,
effective from a date — and has no per-unit dimension at all. There is no way
today to say "$0.40 per GiB".

Two questions come with adding one, and they have to be answered together.

**Precision.** A rate is not an amount. At two decimal places the only rates
expressible are 1c steps per GiB, which is far too coarse — and `C-02` is about
*amounts*, not rates. The repo already has the precedent in two places:
`tenant.tenant_usage_meter.unitPrice` and `currency_exchange_rate.rate` are both
`Decimal(18, 8)`.

**Time.** A Grant issued in September and consumed in November is priced by
something. If the rate is read from the catalog at consumption time, a price
change reprices traffic that was already sold — and under ADR-0072 it reprices
blocks that were **already bought**, so the ledger and the cursor disagree
about what a byte cost. `Grant` already solves this shape for quotas and
feature keys: `grantFromVariant` copies them at issue precisely so a later
catalog edit never changes what was sold.

## Decision

A metered variant carries a **rate per 2^30 bytes**, stored `Decimal(18, 8)`,
in an append-only per-variant history shaped exactly like `catalog.Price` — a
change is a new row, and the same trigger refuses updates and deletes.

**At issue, `GrantService.issue` copies the effective rate onto
`Grant.meteredRate`**, alongside the quotas it already copies. Every block
purchased against that Grant is priced from the Grant's own column, never from
the catalog. The catalog is read once, at the moment of sale.

Bytes are the only stored unit. "GB" is a rendering concern, and the
bytes-per-unit constant lives in one place rather than being spelled in three.

## Consequences

- Positive: yesterday's traffic prices at yesterday's rate, by construction —
  the same property `Price` gives invoices and `quotas` gives entitlements.
- Positive: `C-02` is not bent. The rate is `(18, 8)`; every **amount** derived
  from it is still rounded to whole cents before it reaches the ledger
  (ADR-0072), so nothing finer than two places is ever written as money.
- Positive: repricing is a business decision with no data migration. A new rate
  row affects Grants issued after it and nothing else.
- Negative / accepted cost: a rate cut does not reach existing Grants. A user
  who bought in September pays September's rate until their Grant closes, and
  if that is not wanted it needs an explicit re-issue or an adjustment row —
  there is no "reprice everyone" lever, on purpose.
- Negative / accepted cost: one more append-only history table with its own
  trigger, duplicating `Price`'s shape rather than generalising it. Generalising
  would touch `Price`, which invoices already depend on.
- What this forecloses: reading a live rate at consumption time, and therefore
  surge or time-of-day pricing on an already-issued Grant. Those would have to
  be a multiplier applied at purchase with its own audit trail, not a change to
  where the base rate is read from.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Read the rate from the catalog at consumption time | a price change reprices traffic already sold, and under ADR-0072 reprices blocks already bought — the ledger and the cursor then disagree about what a byte cost, with no way to reconcile |
| Store the rate as `Decimal(18, 2)` | 1c per GiB is the smallest expressible step, which is coarser than real pricing needs. `C-02` governs amounts; the repo already stores rates at `(18, 8)` in two places |
| Put the rate on the Grant only, with no catalog history | nothing to issue from, no record of what was being offered when, and no way to change a price for future sales without editing rows |
| Reuse `catalog.Price` with a unit column | `Price` is read by invoicing and reseller revenue. Adding a dimension to it changes the meaning of every existing row, for one new consumer |

## Revisit trigger

Genuine multi-currency wallets (ADR-0002's own trigger), or a pricing model
where the rate must vary during a Grant's life — time-of-day, congestion, or a
promotion applied retroactively. Any of those reopens where the rate is read.
