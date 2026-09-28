---
id: currency
layer: domain
status: draft
updated: 2026-09-28
---

# Invariants — currency

**DRAFT** — from schema comments; not enforced in code.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Exactly one currency has `isBaseCurrency = true` | planned CHECK/trigger ("section 99") | ambiguous base for all money |
| 2 | Every money row records its own currency; a rate is USD -> code and a pair goes through USD (ADR-0098, superseding ADR-0002's single base) | `currencyCode` columns (F-116-b); `readFxPair` (F-116-c) | a price in the wrong currency; a pair inverted |
| 3 | `currency_exchange_rate` is append-only; historical rates are immutable. A pin ended early gets a `currency_rate_pin_end` row, never an edit | convention (the worker and `currency-service` only insert); `currency_rate_pin_end` is insert-only by grant | audit / dispute failures |
| 4 | Currency resolution order is exactly: user-lock -> global-lock -> user preference -> base | planned resolver | user sees wrong prices |
| 5 | `currency_policy` is unique per `(scope, userId)`; `scope = global` has `userId = NULL` (needs partial unique index) | schema `@@unique` + planned partial index | conflicting locks |
| 6 | A pin is a person's decision, never the market: a live pin prices first, an expired or ended one prices nothing, and none is ever the FX worker's deviation baseline | `readFxRate` `fromPin` / `fromTable` (`source` filters); `FxRateSnapshotStore.lastAccepted` reads `external_api` only; CHECK `currency_exchange_rate_pin_shape` | a stale pin prices sales; the gate refuses the real market as a jump |
| 7 | A rate of any age stays usable; age is shown, not enforced (ADR-0101) | `readFxRate` has no age cut-off | a currency stops selling during an outage |

## How to test

To be written with the service. Minimum: resolver precedence test; second
`isBaseCurrency` insert fails.
