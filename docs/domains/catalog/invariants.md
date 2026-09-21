---
id: catalog
layer: domain
status: draft
updated: 2026-09-21
---

# Invariants — catalog

Held by the database since F-026-a; proved by
`billing-service/src/app/catalog/catalog-schema.int.spec.ts`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A price is USD `Decimal(18,2)` and never negative (ADR-0019) | column type, `price_amount_not_negative` | price drift, a sale that pays the buyer |
| 2 | A price row is history: never deleted, only `isActive` changes | trigger `price_is_history` | yesterday's invoice recomputed at today's price (F-0602) |
| 2b | A metered rate row is history on the same terms | trigger `metered_rate_is_history` | a rate edit reprices traffic already sold, and blocks already bought (ADR-0072/0073) |
| 3 | A variant carries its product's tenant, and a price and a metered rate their variant's; a product sits in its own tenant's category or the platform's | trigger `same_tenant_as_parent` | one tenant sells on another's catalog, or RLS shows the wrong rows |
| 4 | A tenant reads the platform's rows and its own, and writes only its own | RLS shared-read policy | a reseller edits the platform's catalog |
| 5 | Keys and SKUs are unique inside a tenant | partial unique indexes | a direct link buys the wrong variant |
| 6 | Nothing referenced is hard-deleted: a variant may back a Grant or a coupon scope | FKs `ON DELETE RESTRICT` | receipts and Grants pointing at nothing |
| 7 | A metered rate is USD `Decimal(18,8)` and never negative (ADR-0073) | column type, `metered_rate_not_negative` | 1c-per-GiB pricing steps, or a byte that pays the user |

## How to test

`npm run test:int` (billing-service). Unit specs for the reads land with F-026-c.
