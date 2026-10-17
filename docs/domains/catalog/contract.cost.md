---
id: catalog
layer: domain
status: active
version: 12
updated: 2026-10-17
---

# Contract — catalog / a product's cost (F-1002-d, ADR-0151)

What one sale of a variant, and one unit of a meter, cost the tenant that
sells it — read by billing's cost rollup (F-1002-e) so a product with no panel
never reads as 100% margin. `catalog-cost.*` in `billing-service/src/app/catalog/`.

## Storage

`variant_cost` (`amount` per sale, `Decimal(18,2)`, ≥ 0) and `meter_cost`
(`unitCost` for `unitSize` units, `Decimal(18,8)`, ≥ 0), each with
`currencyCode` and `effectiveFrom` — [data-model.md](data-model.md).

1. **History.** A change is a new row from `effectiveFrom`; no row is ever
   changed or deleted (`cost_is_history`), but a variant's go with its variant.
2. **Private to its tenant** — the one catalog table pair with no shared read:
   a reseller never reads what the platform pays its suppliers.
3. **Own items only.** A variant's cost carries its variant's tenant
   (`same_tenant_as_parent`); a reseller's cost of a platform product is what
   it pays the platform (billing), never a row here.
4. **`vpn.traffic` takes no unit cost** (`meter_cost_not_vpn_traffic`): its
   cost is its panels' (`network.panel_cost`).
5. **0 is a cost.** A row of 0 says "costs nothing"; no row says "not set".

## Routes

On `/api/catalog` (behind `catalog.manage`, as every route there) and on
`/api/catalog/tenants/:tenantId` (the reseller's door, `read` / `staffWrite`):

| Route | Body / query | Answer | Refusals |
|---|---|---|---|
| `GET /variants/:id/costs` | — | the history, newest first, ≤ 50: `{id, amount, currencyCode, effectiveFrom, createdAt}` | `variant_not_found` 404 |
| `POST /variants/:id/costs` | `amount`, `effectiveFrom?` | the new row, in the tenant's pricing currency; audited `catalog_variant_cost_set` | the same; 400 for a closed month |
| `GET /meter-costs` | `tenantId?` (ambient, owner: uuid or `platform`) | every meter but `vpn.traffic`: `{meterKey, unit, nameKey, costs[]}` (`costs` as above with `unitSize`) | — |
| `POST /meter-costs` | `meterKey`, `unitSize`, `unitCost`, `effectiveFrom?`, `tenantId?` (ambient) | the new row; audited `catalog_meter_cost_set` | `meter_not_found` 404; 400 for `vpn.traffic` or a closed month |

`effectiveFrom` is no earlier than the 1st of the current UTC month (absent =
now): a closed month's margin never moves, as a panel cost's (F-1002-a).
