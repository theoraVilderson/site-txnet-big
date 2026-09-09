---
id: adr-0019
status: accepted
updated: 2026-09-09
---

# ADR 0019 — The base currency is USD with two decimal places

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** billing, currency, tenant, catalog, engagement, ai

## Context

ADR-0002 fixed the money *shape* — one base currency, `Decimal`, no per-table
currency column, balances derived from an append-only ledger — but left the base
currency itself unchosen. `D-1` in `BACKLOG.md` has blocked F-025 and every
money feature since 2026-09-04.

The platform sells to an Iranian audience who think in Toman, but it buys
upstream capacity and accepts crypto in dollars, and its resellers are not all
in one country. The base currency is the unit the ledger is denominated in
forever; changing it later is a redenomination of every historical row, which is
why ADR-0002 lists exactly that as its revisit trigger.

## Decision

We will make **USD the single `Currency.isBaseCurrency = true` row, with
`decimalPlaces = 2`**. Every `Decimal` money column in every schema is USD. IRT
and IRR exist as selectable display currencies with rows in
`CurrencyExchangeRate`, and are applied at render time only, per ADR-0002.

Because a rial-denominated gateway payment is settled in a currency that is not
the base one, **every payment transaction stores the exchange rate it was
settled at**, not only crypto ones. The schema anticipates this for crypto
(`CryptoPaymentDetail.exchangeRateSnapshot`); the same snapshot is required on
the rial/card payment path, or a settlement can never be reconciled against the
gateway's own record.

## Consequences

- Positive: upstream costs, crypto payments and cross-border reseller
  settlement are all in the ledger's own unit, with no conversion.
- Positive: two decimal places match how every payment processor and accounting
  system outside Iran represents money, so no scaling factor is needed at the
  boundary.
- Negative / accepted cost: the dominant payment path — Iranian rial gateways —
  is now the *converted* one. Every such payment depends on a rate at the moment
  of settlement, and reconciliation compares a stored USD amount plus a snapshot
  against a rial figure from the gateway.
- Negative / accepted cost: a rate that moves between invoice and settlement
  produces a small difference that has to land somewhere explicit. It is not a
  rounding bug to be silenced.
- Forecloses: treating a gateway's rial figure as the authoritative amount;
  quoting a price in rial without recording the rate that produced it.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| IRT (Toman), 0 decimals | matches how users think and how the local gateways settle, but makes every upstream cost and every crypto payment the converted side, and IRT is not an ISO 4217 code |
| IRR (Rial), 0 decimals | ISO-valid and gateway-native, but the same conversion problem as IRT plus larger stored integers and a display layer that must always divide by 10 |

## Revisit trigger

The platform's costs and settlement stop being dollar-denominated — e.g. upstream
capacity is bought in rial and crypto acceptance is dropped. That is a
redenomination, not an edit: it rewrites every historical ledger row.
