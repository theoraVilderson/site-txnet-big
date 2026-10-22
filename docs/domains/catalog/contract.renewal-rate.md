---
id: catalog
layer: domain
status: active
version: 16
updated: 2026-10-22
---

# Contract — catalog / a product's renewal rate (F-305-b, ADR-0158)

What the GiB and days a user types to renew their own Grant cost, and how few
and how many one renewal buys. Read by billing's renewal invoice (F-305-e,
billing [contract.renewal.md](../billing/contract.renewal.md)). Not a
`rate_card`: a rate card prices a meter's use on a variant and is locked onto a
Grant at sale; a renewal rate prices one top-up of a product and is read at the
invoice. `renewal-rate.*` in `billing-service/src/app/catalog/`, proved by
`renewal-rate.service.spec.ts`; migration `20261022000900`.

## Storage

`renewal_rate`: `pricePerGib`, `pricePerDay` (`Decimal(18,8)`), `minGib`,
`maxGib`, `minDays`, `maxDays` (integers), `currencyCode`, `effectiveFrom` —
[data-model.md](data-model.md).

1. **History.** A change is a new row from `effectiveFrom`, never in the past
   (`price_in_the_past`, as a price's); no row is changed or deleted
   (`renewal_rate_is_history`), but a product's rows go with it (cascade).
2. **Off is a row.** Switching custom renewal off writes a row with no prices
   and no bounds (`renewal_rate_off_whole`: all six or none, ADR-0151's
   take-back). No row in effect, or an off row in effect, means custom renewal
   is off for that product. An older rate behind an off row is never read.
3. **A part not sold has a maximum of 0**; a part sold costs more than 0
   (`renewal_rate_sold_part_priced`), and at least one part is sold
   (`renewal_rate_sells_something`). `0 <= min <= max` for each
   (`renewal_rate_bounds_ok`). The edge refuses the same first, with a reason
   a form can show (below).
4. **Its product's tenant**, by the composite key `(productId, tenantId)`;
   shared read, as a price: a reseller's buyers are priced by the platform's
   rate on a platform product, and a reseller cannot write one.
5. **In its tenant's operating currency** when written, and read only in the
   reader's (invariant 11): a row in another currency is no rate. A unit rate
   is not rounded to the currency's places; the total is, once (ADR-0153).
   A currency change writes the row in effect and every one scheduled after
   it again in the new money, off rows included (billing
   `contract.currency-change.md`, summary `renewalRates`).

## Routes

On `/api/catalog` (behind `catalog.manage`, as every route there) and on
`/api/catalog/tenants/:tenantId` (the reseller's door, `read` / `staffWrite`):

| Route | Body | Answer | Refusals |
|---|---|---|---|
| `GET /products/:id/renewal-rates` | — | `{inEffect, history}`: the rate in effect now in the product's tenant's currency (`null` = custom renewal off) and the history, newest first, ≤ 50. A row: `{id, pricePerGib, pricePerDay, minGib, maxGib, minDays, maxDays, isOff, currencyCode, effectiveFrom, createdAt}`, prices as decimal strings, all six null when `isOff` | `product_not_found` 404 (another tenant's, or the platform's to a reseller) |
| `POST /products/:id/renewal-rates` | `pricePerGib`, `pricePerDay` (≤ 8 places), `minGib`, `maxGib` (0…100,000), `minDays`, `maxDays` (0…3,650), `effectiveFrom?` | `201` the new row; audited `catalog_renewal_rate_set`, target `renewal_rate` | the same; `price_in_the_past` 400; schema 400s `renewal_bounds_reversed`, `renewal_sells_nothing`, `renewal_sold_part_free` |
| `POST /products/:id/renewal-rates/off` | `effectiveFrom?` | `201` the off row; audited `catalog_renewal_rate_off` | as above |
