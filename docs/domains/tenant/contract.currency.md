---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-09-28
---

# Contract — tenant / operating currency

A topic file of `contract.md` (§10). The currency a tenant keeps its books in
(F-116-a, ADR-0098 part 1). Code: `txnet-backend/tenant-service/src/app/currency/`.
What is priced, charged and converted in it is the rest of the F-116 series.

## The routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/tenants/:id/operating-currency` | a reseller: its owner, a staff member, or platform staff with `tenant.manage` (`ResellerAccess`, invariant 21). The platform's own tenant: only its staff with `tenant.manage` | `{code, changeable, choices: [{code, name, symbol, decimalPlaces}]}` |
| `PUT /api/tenants/:id/operating-currency` | same, `staffWrite` | `{code}` (`^[A-Z]{3}$`, strict) → the same view |

Refusals: `not_allowed` 403, `reseller_suspended` 403, `reseller_not_found`
404 (staff only), `reseller_terminated` 409, `currency_unavailable` 409,
`tenant_has_money` 409; a body the schema refuses is 400.

## Rules

| Rule | Why |
|---|---|
| 1. Every tenant has one, `tenant.operatingCurrencyCode`, default `USD`, the `platform_owner` row's being the platform's. A CHECK holds the shape; there is no FK, because `currency.currency` is seeded, not migrated | existing tenants keep meaning what they stored (ADR-0098 part 1); a fresh database has no currency rows |
| 2. **Only a currency with a rate is a choice**: active, `decimalPlaces` ≤ 2, and either the base (USD, the pivot) or holding an active `currency_exchange_rate` row. Until the staleness ladder (F-0607-a) exists, any active row counts | money columns are `DECIMAL(18,2)` (part 6); a tenant priced in a currency with no rate cannot be converted at the tenant ↔ platform boundary (parts 4, 8) |
| 3. **A change is refused while the tenant has money** (`tenant_has_money`, `changeable: false` on the read): a ledger row in one of its users' wallets, an invoice, a payment, a `Price` or `MeteredRate` row. For the platform also a `tenant_billing_transaction`, a `tenant_feature_package`, and the platform-wide (`tenantId` null) prices. A reseller's own billing wallet does not count against it — it is in the platform's currency | nothing converts a stored amount yet; F-116-f does, and lifts this rule |
| 4. A set to the code it already has is not a change: 200, nothing written, money or not | a retried request is harmless |
| 5. The probe and the write are not one transaction | a first payment racing a first currency choice is F-116-f's to convert; no money is lost, only mislabelled until then |
| 6. The platform's own tenant is not a reseller, so `ResellerAccess` does not admit it: the caller must be signed in to it and hold `tenant.manage`. A reseller's `tenant.manage` is its own tenant's, never the platform's | the platform's currency prices every reseller's billing (part 4) |

## Consumers

| unit | uses |
|---|---|
| panel-web | the two routes, from the settings screen (F-116-h, not built) |
| billing, catalog | `tenant.operatingCurrencyCode`, read with the tenant (F-116-b, F-116-d, not built) |
