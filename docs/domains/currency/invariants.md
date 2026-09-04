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
| 2 | No monetary amount is ever stored in a non-base currency (ADR-0002) | billing/tenant schema design | drift, rounding loss |
| 3 | `currency_exchange_rate` is append-only; historical rates are immutable | planned service layer | audit / dispute failures |
| 4 | Currency resolution order is exactly: user-lock -> global-lock -> user preference -> base | planned resolver | user sees wrong prices |
| 5 | `currency_policy` is unique per `(scope, userId)`; `scope = global` has `userId = NULL` (needs partial unique index) | schema `@@unique` + planned partial index | conflicting locks |

## How to test

To be written with the service. Minimum: resolver precedence test; second
`isBaseCurrency` insert fails.
