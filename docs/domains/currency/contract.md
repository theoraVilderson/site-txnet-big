---
id: currency
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — currency

**DRAFT — schema only.** From `txnet-backend/prisma/domains/currency.prisma`.

## TL;DR

Money is stored once in the base currency (ADR-0002). This unit converts to a
display currency **only at render time**. Resolution order for which currency a
user sees: user-lock policy -> global-lock policy -> `user_currency_preference`
-> base currency.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| list selectable currencies | — | active currencies with `isSelectableByUser` | sync | — |
| resolve display currency | userId | currency code (per resolution order) | sync | — |
| convert for display | base amount, target currency | rounded display amount + rate used | sync | no active rate |
| set user preference | userId, currencyId | `user_currency_preference` | sync | not selectable |
| set exchange rate | currencyId, rate, source | new append-only `currency_exchange_rate` | sync | — |
| set currency policy | scope (global/user), lock, enforced currency | `currency_policy` | sync | — |

## Emits (events)

None. Rates are cached in Redis (`fx:rate:{code}`) by whatever writes them.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` for preferences and user-scoped policies | preference/policy ops blocked |

## Guarantees (intended)

- Exactly one `currency.isBaseCurrency = true` (planned CHECK/trigger).
- Exchange rates are append-only; a change is a new row with `effectiveAt`, never
  an edit.
- Conversion never mutates a stored amount.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
