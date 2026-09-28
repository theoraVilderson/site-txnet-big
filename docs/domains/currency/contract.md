---
id: currency
layer: domain
status: active
version: 6
updated: 2026-09-28
---

# Contract — currency

**Mostly draft.** The rate reader (F-116-c) and `currency-service`'s rate read
(F-116-k) are built; the display-currency operations under "Provides
(intended)" are still schema only. Every one of them is `currency-service`'s
when built (ADR-0100).

## TL;DR

A tenant's money is in its own operating currency (ADR-0098; ADR-0002's single
base is amended). This unit owns the rates — USD -> code, USD the pivot — and
converts to a display currency **only at render time**. Resolution order for which currency a
user sees: user-lock policy -> global-lock policy -> `user_currency_preference`
-> base currency.

## Rate reader (built, F-116-c; pins F-0608-a)

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
5. **Age is not judged here** — F-0607-a reads `effectiveAt`; a rate of any
   age stays usable (ADR-0101).
6. **A live pin answers first** (F-0608-a, ADR-0101 part 3): a `manual_admin`
   row not expired and not ended, the newest if several, read from the table on
   every call (a Redis flush must not drop a pin). The snapshot then carries
   `pinned: {reason, expiresAt}`; its id is the pin row, so a price records it.
   A failed pin read is a warning and falls through to the discovered rate.
   The table fallback reads discovered (`external_api`) rows only.
7. **Whose pin** (F-116-j, ADR-0098 part 9): `readFxRate(…, { tenantId })` /
   `readFxPair(…, { tenantId })` read that tenant's own live pin, then the
   platform's. The table is under RLS, so given a service the reader binds
   exactly that tenant in a transaction for the pin lookup (`pinRow`); given a
   transaction client, the caller's binding stands. **Without a tenant no tenant's pin is ever read** — that is the
   tenant ↔ platform boundary (a billing top-up, anything the platform charges
   a tenant). Callers say whose books they price (billing
   `contract.gateways.md`, tenant `contract.currency.md` rule 7).
8. **A tied currency is its root divided** (F-116-m, user 2026-09-28):
   `DERIVED_CURRENCIES` (in `fx-rate.ts`, the one declaration) maps `IRT` to
   `{of: 'IRR', divisor: 10}`. Its snapshot is the root's — same `snapshotId`,
   `pinned`, `effectiveAt` — with `rate / divisor` and its own code; a rial pin
   moves it. It has no pin, cache key or rate row of its own and the worker
   never fetches it. A pair of one root (IRR ↔ IRT) is the exact ratio, both
   legs from one read.

## HTTP API (`currency-service`, ADR-0100)

Behind Traefik and ForwardAuth (`/api/currency/*`), the shared guards (C-11).

| Route | Who | Answer | Errors |
|---|---|---|---|
| `GET /api/currency/rates` (F-116-k) | any signed-in caller | every active currency: `{code, name, symbol, decimalPlaces, isBase, rate, snapshotId, effectiveAt, pinned}`, `rate` a decimal string per USD from `readFxRate`, `null` when it has none; the base currency `"1"`; `pinned` `{reason, expiresAt}` while a pin prices it | 401 from the gate; 429 (`CURRENCY_READ`, 120/min) |
| `GET /api/currency/pins/:code` (F-0608-a, F-116-j) | `currency.pin`; the platform or a tenant | the pin form: `{current, platformPin, lastAccepted, lastDownload}` — `current` the caller's own live pin, `platformPin` the platform's beside a tenant's — the live pin, the last discovered rate, the worker's last reading (`fx:reading:{code}`, a suggestion, never a rate) | 403 (incl. `currency_not_yours`); 404 `currency_not_found`; 409 `base_currency` / `derived_currency` |
| `POST /api/currency/pins` (F-0608-a) | same | `{code, rate, reason, hours 1–720}` → the pin, rate rounded to 8 places; a `manual_admin` row + `admin_audit_log` (`currency_rate_pin`) in one tenant-bound transaction | 400 validation / `invalid_rate`; 403; 404; 409 `base_currency` / `derived_currency` (IRT: pin IRR, rule 8); 429 (`CURRENCY_PIN_WRITE`, 30/15 min) |
| `POST /api/currency/pins/:id/end` (F-0608-a) | same | the pin with `endedAt`; a `currency_rate_pin_end` row + audit (`currency_rate_pin_end`); the pin row is never edited | 404 `pin_not_found`; 409 `pin_over` (ended, expired, or ended concurrently) |

**Access**: `currency.pin` at the door (granted to `Admin`). Inside, the
platform owner pins for everyone (`tenantId` null); **any other tenant pins
for its own books only** (F-116-j): its operating currency, or a currency its
own selectable gateways charge in — billing's internal
`charge-currencies` answer (`BillingClient`; unreachable = operating currency
only). Otherwise 403 `currency_not_yours`. A tenant ends only its own pin and
the platform only its own (else 404 `pin_not_found`). `GET /rates` answers
each caller the rate its own books price at. A newer pin supersedes an older
live one; nothing merges them.

Age is not judged here (F-0607-a, ADR-0101). The service fetches no rate.

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
