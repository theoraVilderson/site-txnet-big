---
id: adr-0002
status: accepted
updated: 2026-09-04
---

# ADR 0002 — Money is base-currency Decimal, balances are ledger-derived

- **Status:** accepted
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** billing, currency, tenant, engagement, ai

## Context

Multi-currency display, real money, refunds and commissions. Storing an amount in
more than one currency (or caching a balance as the truth) guarantees drift and
silent loss.

## Decision

We will store every monetary value once, as `Decimal` **in the system base
currency** (the single `Currency.isBaseCurrency = true`). No monetary table has
its own currency column. Display currency is applied only at render time from
`CurrencyExchangeRate` (append-only). Balances are **never** written directly:
each `Wallet` / `TenantBillingWallet` keeps a `cachedBalance` + optimistic-lock
`version`, and the truth is the append-only `*Transaction` ledger. A balance
mutation is one Postgres transaction: append ledger row + update cache.

## Consequences

- Positive: auditable, reconstructable, currency-safe.
- Negative / accepted cost: every read that needs a non-base currency must join
  the rate table; historical rates must be snapshotted on the transaction
  (`CryptoPaymentDetail.exchangeRateSnapshot`).
- Forecloses: quick "just UPDATE the balance" fixes; multi-currency wallets.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Balance column as source of truth | no audit trail, race conditions |
| Amount stored per-currency | drift, rounding, reconciliation nightmare |
| Floats for money | precision loss |

## Revisit trigger

Introducing genuine multi-currency wallets, or a base-currency redenomination.
