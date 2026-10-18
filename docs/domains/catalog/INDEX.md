---
id: catalog
layer: domain
status: active
version: 15
keywords: [catalog, sales cap, max sales, sold out, limited stock, how many can be sold, سقف فروش, حداکثر فروش, تمام شد, product audience, who can buy a product, product for chosen groups, product sold to a group, محصول برای گروه, package lists product, what a reseller may sell, product not in package, rate card, rate cards, per-unit price, prepaid or postpaid, included quantity, hybrid plan, meter, meters, meter registry, usage meter, what is counted, vpn.traffic, vpn.config.regenerate, config regenerate meter, price currency, currency of a price, product, category, subcategory, category tree, product in several categories, variant, sku, price, price history, visibility, fulfilment kind, product model, delete product, archive product, capability, capabilities, feature key, what a product unlocks, traffic quota, unlimited traffic, unlimited duration, campaign, campaign price, time-boxed price, countdown, cancel a campaign, season, seasons, seasonal price, nowruz, yalda, thursday night, jalali calendar, قیمت فصلی, نوروز, یلدا, شب جمعه]
source: [txnet-backend/prisma/domains/catalog.prisma, txnet-backend/prisma/domains/migrations/20260914001500_catalog_product_model/**, txnet-backend/prisma/domains/migrations/20260925000300_a_product_never_sold_can_be_deleted/**, txnet-backend/prisma/domains/migrations/20260925000800_a_category_with_no_products_can_be_deleted/**, txnet-backend/prisma/domains/migrations/20260925001000_categories_nest_and_a_product_sits_in_several/**, txnet-backend/prisma/domains/migrations/20260925001400_a_capability_is_a_catalog_row/**, txnet-backend/prisma/domains/migrations/20260928002600_a_price_is_in_its_tenants_currency/**, txnet-backend/prisma/domains/migrations/20260929000200_a_meter_is_a_catalog_row/**, txnet-backend/prisma/domains/migrations/20260929000300_a_rate_card_prices_a_meter/**, txnet-backend/prisma/domains/migrations/20260929001300_a_config_regenerate_is_a_meter/**, txnet-backend/prisma/domains/migrations/20261002001900_a_campaign_is_two_price_rows/**, txnet-backend/prisma/domains/migrations/20261002002000_a_campaign_is_audited/**, txnet-backend/prisma/domains/migrations/20261002002100_a_season_writes_its_campaigns/**, txnet-backend/prisma/domains/migrations/20261013000200_the_platform_is_a_tenant_in_the_catalog/**, txnet-backend/prisma/domains/migrations/20261013000300_a_product_may_serve_chosen_groups/**, txnet-backend/prisma/domains/migrations/20261017000800_a_product_has_a_cost/**, txnet-backend/prisma/domains/migrations/20261018000500_a_variant_may_cap_its_sales/**, txnet-backend/prisma/domains/migrations/20261018000600_a_variant_counts_its_sales/**, txnet-backend/prisma/domains/migrations/20261018000700_a_variant_sales_move_names_its_columns/**, txnet-backend/prisma/domains/migrations/20261018000800_a_variant_may_cap_its_live_services/**, txnet-backend/billing-service/src/app/catalog/**, txnet-backend/shared-core/src/lib/catalog/**]
owns_tables: [product_category, product_category_link, product_capability, meter, product, product_audience, product_variant, price, rate_card, variant_cost, meter_cost]
depends_on: [tenant]
updated: 2026-10-18
---

# Catalog

**Responsibility (one sentence):** what is for sale — categories, products,
variants (the SKU), each variant's price history and its rate cards per meter, in its tenant's currency.
**Explicitly NOT responsible for:** what a user holds (`entitlement`), coupons
and taking money (`billing`), provisioning (`network`), display-currency prices
(`currency`).

Runs as a module inside `billing-service` (ADR-0049). Spec:
`python3 tools/spec.py --section 4.1` .. `4.3`, F-501, F-0601, F-0602.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing catalog from outside |
| [contract.campaigns.md](contract.campaigns.md) | a time-boxed price (campaign), its two price rows, cancel, the offer's countdown (F-503-a); seasons — Nowruz, Yalda, Thursday night — and how their occurrences are written (F-505-a) |
| [contract.cost.md](contract.cost.md) | what a sale or a unit of use costs the tenant — a variant's and a meter's cost history, private to the tenant (F-1002-d) |
| [contract.sales-cap.md](contract.sales-cap.md) | how many of a variant may be sold — the cap, sold and held counts, sold out (F-513) |
| [contract.audience.md](contract.audience.md) | who may buy a product — every user or chosen groups; the shop, a direct link, an issue by hand (PT-1-b) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-10-18 | v15 (F-514-a, additive): a variant's active cap — `activeCap`, `active` on the variant view, `catalog.live_grants_of`; an offer's `remaining`/`soldOut` cover both caps ([contract.sales-cap.md](contract.sales-cap.md) "The active cap"). Consumers: billing (F-514-b/c), panel-web (F-514-d), bot-app (F-513-d) |
| 2026-10-18 | v14 (F-513-b, additive): the counts' writer `moveSales` / `countSaleOf` and `catalog.variant.sales_changed` ([contract.sales-cap.md](contract.sales-cap.md) "The writers"). Consumers: billing (same change), panel-web (F-513-c), bot-app (F-513-d) |
| 2026-10-18 | v13 (F-513-a, additive): a variant's sales cap — `salesCap`/`soldCount`/`reservedCount`, `sales` on the variant view, `remaining`/`soldOut` on an offer ([contract.sales-cap.md](contract.sales-cap.md)). Consumers: billing (F-513-b), panel-web (F-513-c), bot-app (F-513-d) |
| 2026-10-17 | v12 (F-1002-d, ADR-0151, additive): `variant_cost`, `meter_cost` and their routes ([contract.cost.md](contract.cost.md)). Consumer: billing (cost rollup, F-1002-e) |
| 2026-10-14 | **draft -> active** (OPS-1-ab): status caught up with code already shipped (billing-service `catalog/`); no contract change |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
