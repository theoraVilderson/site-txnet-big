---
id: tenant
layer: domain
status: active
version: 2
updated: 2026-09-28
---

# Contract — tenant / operating currency

A topic file of `contract.md` (§10). The currency a tenant keeps its books in
(F-116-a, ADR-0098 part 1), and changing it (F-116-f, part 5). Code:
`txnet-backend/tenant-service/src/app/currency/`. What a change converts is
billing's: [billing/contract.currency-change.md](../billing/contract.currency-change.md).

## The routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/tenants/:id/operating-currency` | a reseller: its owner, a staff member, or platform staff with `tenant.manage` (`ResellerAccess`, invariant 21). The platform's own tenant: only its staff with `tenant.manage` | `{code, choices: [{code, name, symbol, decimalPlaces}]}` |
| `PUT /api/tenants/:id/operating-currency` | same, `staffWrite` | `{code}` (`^[A-Z]{3}$`, strict) → `{code, choices, conversion}`; `conversion` is `{changeId, fromCode, rate, summary}` (what was converted, by kind), `null` when the code was already the tenant's |

Refusals: `not_allowed` 403, `reseller_suspended` 403, `reseller_not_found`
404 (staff only), `reseller_terminated` 409, `currency_unavailable` 409,
`currency_changed` 409 (another change won the race; re-read and retry),
`rate_unavailable` 503 (no rate for the pair); a body the schema refuses is
400. v2 (F-116-f) removed `changeable` and `tenant_has_money`.

## Rules

| Rule | Why |
|---|---|
| 1. Every tenant has one, `tenant.operatingCurrencyCode`, default `USD`, the `platform_owner` row's being the platform's. A CHECK holds the shape; there is no FK, because `currency.currency` is seeded, not migrated | existing tenants keep meaning what they stored (ADR-0098 part 1); a fresh database has no currency rows |
| 2. **Only a currency with a rate is a choice**: active, `decimalPlaces` ≤ 2, and either the base (USD, the pivot) or holding an active `currency_exchange_rate` row. Until the staleness ladder (F-0607-a) exists, any active row counts | money columns are `DECIMAL(18,2)` (part 6); a tenant priced in a currency with no rate cannot be converted at the tenant ↔ platform boundary (parts 4, 8) |
| 3. **A change converts the tenant's money** (F-116-f): the pair old -> new is read once (`readFxPair`), and billing's `convertOperatingCurrency` converts every live amount at it in one transaction on the cross-tenant pool, audited (`tenant_currency_change`). History keeps its currency. A reseller's own billing wallet is not its money — it is in the platform's currency, converted only by the **platform's** change, which also converts every reseller's billing wallet and the packages it sells | ADR-0098 part 5; the user chose conversion over a lock (D-50) |
| 4. A set to the code it already has is not a change: 200, `conversion: null`, nothing read or written | a retried request is harmless |
| 5. **No rate, no change** (`rate_unavailable`): nothing is converted at a guessed rate. A change that finds the tenant no longer in the currency its rate was read from is refused (`currency_changed`), not converted | part 5: one snapshot, and the right one |
| 6. The platform's own tenant is not a reseller, so `ResellerAccess` does not admit it: the caller must be signed in to it and hold `tenant.manage`. A reseller's `tenant.manage` is its own tenant's, never the platform's | the platform's currency prices every reseller's billing (part 4) |
| 7. **The pair is read in the tenant's own books** (F-116-j): `readFxPair(…, { tenantId: target.id })`, so its own live pin converts before the platform's | ADR-0098 part 9: a tenant's rate prices its own currency change, and only that tenant's |

## Consumers

| unit | uses |
|---|---|
| panel-web | the two routes: a reseller's on its workspace `/my-resellers/:id`, the platform's on `/settings` (F-116-h, built; `panel-web/contract.currency.md`) |
| billing | `tenant.operatingCurrencyCode` through shared-core `operatingCurrencyOf` / `platformCurrencyOf`, stamped on every new money row (F-116-b, built); a change runs billing's `convertOperatingCurrency` (F-116-f, built) |
| catalog | the same, for `Price` and `MeteredRate`; a reader offers only prices in it (F-116-d, built) |
