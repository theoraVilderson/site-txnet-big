---
id: currency
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — currency

**DRAFT** — from schema comments; not enforced in code.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Exactly one currency has `isBaseCurrency = true` | planned CHECK/trigger ("section 99") | ambiguous base for all money |
| 2 | Every money row records its own currency; a rate is USD -> code and a pair goes through USD (ADR-0098, superseding ADR-0002's single base) | `currencyCode` columns (F-116-b); `readFxPair` (F-116-c) | a price in the wrong currency; a pair inverted |
| 3 | `currency_exchange_rate` is append-only; historical rates are immutable | planned service layer | audit / dispute failures |
| 4 | Currency resolution order is exactly: user-lock -> global-lock -> user preference -> base | planned resolver | user sees wrong prices |
| 5 | `currency_policy` is unique per `(scope, userId)`; `scope = global` has `userId = NULL` (needs partial unique index) | schema `@@unique` + planned partial index | conflicting locks |

## How to test

To be written with the service. Minimum: resolver precedence test; second
`isBaseCurrency` insert fails.
