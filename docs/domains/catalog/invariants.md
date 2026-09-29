---
id: catalog
layer: domain
status: draft
updated: 2026-09-29
---

# Invariants — catalog

Held by the database since F-026-a; proved by
`billing-service/src/app/catalog/catalog-schema.int.spec.ts`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A price is `Decimal(18,2)` in its own `currencyCode` and never negative (ADR-0098) | column type, `price_amount_not_negative`, `price_currency_code_shape` | price drift, a sale that pays the buyer |
| 2 | A price row is history: never deleted on its own, only `isActive` changes; it goes only with its variant (cascade; the trigger allows a delete once the variant is gone, F-026-h) | trigger `price_is_history` | yesterday's invoice recomputed at today's price (F-0602) |
| 2b | A rate card is history on the same terms, and goes with its variant the same way (F-118-d; `metered_rate` before it) | trigger `rate_card_is_history` | a rate edit reprices traffic already sold, and blocks already bought (ADR-0072/0073) |
| 3 | A variant carries its product's tenant, and a price and a rate card their variant's — so a tenant prices only its own variants (F-118-d); a product is filed (a link carrying its tenant) in its own tenant's categories or the platform's | triggers `same_tenant_as_parent`, `category_link_ok` | one tenant sells on another's catalog, or RLS shows the wrong rows |
| 4 | A tenant reads the platform's rows and its own, and writes only its own | RLS shared-read policy | a reseller edits the platform's catalog |
| 5 | Keys and SKUs are unique inside a tenant | partial unique indexes | a direct link buys the wrong variant |
| 6 | Nothing referenced is hard-deleted: a variant may back a Grant or a coupon scope. A product removal that meets one archives instead (F-026-h); a category any product sits in, archived included, is kept (`has_products`, F-026-j), or archived when removed with its products (F-026-l); a category another sits under is kept (`has_children`, F-026-r) | FKs `ON DELETE RESTRICT` (Postgres `23001`) | receipts and Grants pointing at nothing |
| 8 | Categories form a tree: a child under its own tenant's category or the platform's, never under itself or its subtree; at most `CATEGORY_MAX_DEPTH` (3) levels; a product is live while **one** of its categories is live — it and every one above it on (F-026-q/r) | trigger `category_parent_ok` (cycle, tenant, one re-parent at a time); `placeUnder` (depth); `category-tree.ts` (live) | a loop no reader ends; a switched-off parent whose children keep selling |
| 9 | A product's `featureKeys` names only capabilities its tenant sees (the platform's or its own); a capability a product or a Grant holds is never deleted, and its key never changes (F-114-f-a, ADR-0086) | `knownCapabilities` / `removeCapability` under row locks; `capability_key_free` trigger for key clashes | a Grant unlocking a capability nobody can name, or a name that changes what was sold |
| 7 | A rate card's `unitPrice` is `Decimal(18,8)` in its own `currencyCode`, and above zero whenever it is charged past what is included (ADR-0073, F-027-al, F-118-d) | column type, `rate_card_metered_price_positive`, `rate_card_unit_price_not_negative` | 1c-per-GiB pricing steps; a byte that pays the user; or a rate of zero, which stalls its Grant at the first block instead of serving free traffic |
| 10 | A prepaid `network_access` variant states its traffic: a `traffic_bytes` quota, where `0` means unlimited — the only place 0 means that; downstream it is an explicit flag (F-111-q). A row made before this is refused at sale, not locked against edits (F-111-p) | `CatalogAdminService.refuseUnstatedTraffic` (`traffic_quota_required`); `sellsTrafficToday` at invoice create and in the shop | a Grant filled with 0 bytes: never placed on a panel, refunded an hour after it was paid |
| 12 | A meter is a platform row written only by a migration, and its `key` and `unit` never change (F-118-c, ADR-0105 decision 2); its name is committed in `locales/shareds/<lang>/catalog.json` for every panel language with the code that adds it (F-118-s) | service roles SELECT only; trigger `meter_is_immutable`; `meter-names.spec.ts` | a tenant inventing a meter nothing reports, or a rate card and a Grant priced in a unit that changed under them |
| 13 | A rate card prices a meter that exists, and says what it serves: a `stop` card includes some quantity; a VPN Grant locks only a card the byte engine serves (prepaid, 2^30 bytes, 0 included, then metered) and a newer card of another shape is no rate, never the older one (F-118-d) | FK on `meter.key`, `rate_card_stop_includes_some`; `vpnTrafficRateAt` (`rate-card.spec.ts`) | usage no meter reports, billed; a postpaid or hybrid card sold at a stale prepaid price |
| 11 | A tenant is offered only prices and rates in its operating currency; a row in another is no price, never converted (F-116-d, ADR-0098 part 2) | `effectiveIn`, `pricesInEffect` / `rateCardsInEffect` (`price-currency.spec.ts`) | a rial user quoted the platform's dollar amount as rial, or a debit the ledger refuses at the last step |

## How to test

`npm run test:int` (billing-service). Unit specs for the reads land with F-026-c.
