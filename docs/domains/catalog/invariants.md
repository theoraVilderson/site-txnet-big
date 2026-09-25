---
id: catalog
layer: domain
status: draft
updated: 2026-09-25
---

# Invariants — catalog

Held by the database since F-026-a; proved by
`billing-service/src/app/catalog/catalog-schema.int.spec.ts`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A price is USD `Decimal(18,2)` and never negative (ADR-0019) | column type, `price_amount_not_negative` | price drift, a sale that pays the buyer |
| 2 | A price row is history: never deleted on its own, only `isActive` changes; it goes only with its variant (cascade; the trigger allows a delete once the variant is gone, F-026-h) | trigger `price_is_history` | yesterday's invoice recomputed at today's price (F-0602) |
| 2b | A metered rate row is history on the same terms, and goes with its variant the same way | trigger `metered_rate_is_history` | a rate edit reprices traffic already sold, and blocks already bought (ADR-0072/0073) |
| 3 | A variant carries its product's tenant, and a price and a metered rate their variant's; a product is filed (a link carrying its tenant) in its own tenant's categories or the platform's | triggers `same_tenant_as_parent`, `category_link_ok` | one tenant sells on another's catalog, or RLS shows the wrong rows |
| 4 | A tenant reads the platform's rows and its own, and writes only its own | RLS shared-read policy | a reseller edits the platform's catalog |
| 5 | Keys and SKUs are unique inside a tenant | partial unique indexes | a direct link buys the wrong variant |
| 6 | Nothing referenced is hard-deleted: a variant may back a Grant or a coupon scope. A product removal that meets one archives instead (F-026-h); a category any product sits in, archived included, is kept (`has_products`, F-026-j), or archived when removed with its products (F-026-l); a category another sits under is kept (`has_children`, F-026-r) | FKs `ON DELETE RESTRICT` (Postgres `23001`) | receipts and Grants pointing at nothing |
| 8 | Categories form a tree: a child under its own tenant's category or the platform's, never under itself or its subtree; at most `CATEGORY_MAX_DEPTH` (3) levels; a product is live while **one** of its categories is live — it and every one above it on (F-026-q/r) | trigger `category_parent_ok` (cycle, tenant, one re-parent at a time); `placeUnder` (depth); `category-tree.ts` (live) | a loop no reader ends; a switched-off parent whose children keep selling |
| 7 | A metered rate is USD `Decimal(18,8)` and strictly positive (ADR-0073, F-027-al) | column type, `metered_rate_is_positive` | 1c-per-GiB pricing steps; a byte that pays the user; or a rate of zero, which stalls its Grant at the first block instead of serving free traffic |

## How to test

`npm run test:int` (billing-service). Unit specs for the reads land with F-026-c.
