---
id: catalog
layer: domain
status: draft
version: 3
keywords: [catalog, product, category, variant, sku, price, price history, visibility, fulfilment kind, product model, delete product, archive product]
source: [txnet-backend/prisma/domains/catalog.prisma, txnet-backend/prisma/domains/migrations/20260914001500_catalog_product_model/**, txnet-backend/prisma/domains/migrations/20260925000300_a_product_never_sold_can_be_deleted/**, txnet-backend/prisma/domains/migrations/20260925000800_a_category_with_no_products_can_be_deleted/**, txnet-backend/billing-service/src/app/catalog/**, txnet-backend/shared-core/src/lib/catalog/**]
owns_tables: [product_category, product, product_variant, price]
depends_on: [tenant]
updated: 2026-09-25
---

# Catalog

**Responsibility (one sentence):** what is for sale — categories, products,
variants (the SKU) and each variant's USD price history.
**Explicitly NOT responsible for:** what a user holds (`entitlement`), coupons
and taking money (`billing`), provisioning (`network`), display-currency prices
(`currency`).

Runs as a module inside `billing-service` (ADR-0049). Spec:
`python3 tools/spec.py --section 4.1` .. `4.3`, F-501, F-0601, F-0602.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing catalog from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-25 | v3 (F-026-h): `POST /products/remove` — a product nothing references is **deleted** with its variants (a price goes with its variant); a referenced one is archived (`archivedAt`) |
| 2026-09-14 | v2 (F-026-a, ADR-0049): **`service_plan` and `service_plan_promotion` removed** for product → variant → price; coupon scope names a product or a variant |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
