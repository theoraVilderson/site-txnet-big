---
id: catalog
layer: domain
status: draft
version: 1
keywords: [catalog, product, category, plan, promotion]
source: []
owns_tables: [product_category, service_plan, service_plan_promotion]
depends_on: [tenant]
updated: 2026-09-04
---

# Catalog

**Responsibility (one sentence):** the sellable-things catalogue — product
categories (VPN, fake-member, ...), service plans with their billing model and
base-currency prices, and direct (codeless) plan promotions.
**Explicitly NOT responsible for:** coupons (`billing`), provisioning a purchased
plan (`network`), display-currency prices (`currency`).

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
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
