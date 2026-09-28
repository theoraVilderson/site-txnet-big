---
id: currency
layer: domain
status: active
version: 2
updated: 2026-09-28
---

# Contract — currency

**Mostly draft.** The rate reader below is built (F-116-c); the display-currency
operations under "Provides (intended)" are still schema only.

## TL;DR

A tenant's money is in its own operating currency (ADR-0098; ADR-0002's single
base is amended). This unit owns the rates — USD -> code, USD the pivot — and
converts to a display currency **only at render time**. Resolution order for which currency a
user sees: user-lock policy -> global-lock policy -> `user_currency_preference`
-> base currency.

## Rate reader (built, F-116-c)

`txnet-backend/shared-core/src/lib/currency/fx-rate.ts` — the **only** way a
service reads a rate. A second hand-rolled read of `fx:rate:*` is drift.

| Operation | Input | Output | Errors |
|---|---|---|---|
| `readFxRate(db, cache, code, log?)` | a currency code | `{snapshotId, currencyCode, rate, effectiveAt}` — `fx:rate:{code}` first, the newest `currency_exchange_rate` row second | never throws; `null` when neither store has a usable snapshot |
| `readFxPair(db, cache, from, to, log?)` | two codes | `{fromCode, toCode, rate, from, to}`: one `from` is `rate` of `to` | never throws; `null` when either non-pivot leg has no rate |

Rules a caller may rely on:

1. **USD is the pivot** (`FX_PIVOT_CURRENCY`, ADR-0098 part 6). A pair is
   `rate(to) / rate(from)`, each leg at its own latest snapshot. The pivot's
   leg is `null` (its rate is exactly 1; no row backs it); a code to itself is
   exactly 1 with no read.
2. **Never half a pair.** A missing leg makes the pair `null`; the caller maps
   `null` to its own "no rate" (billing: `staticRate` or a 503).
3. **A snapshot is id + positive rate + `effectiveAt`, or nothing** (ADR-0019).
   A cache value missing one, unparseable, or naming another code falls through
   to the table; Redis down falls through too.
4. **The rate is not rounded.** The caller rounds the converted **amount** once,
   to the target currency's `decimalPlaces`, and records both legs'
   `snapshotId`s (F-116-e, F-116-g).
5. **Age is not judged here** — F-0607-a's ladder reads `effectiveAt`.

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
