---
id: catalog
layer: domain
updated: 2026-09-14
---

# Data model — catalog

Source of truth: `txnet-backend/prisma/domains/catalog.prisma` (Postgres schema
`catalog`), migration `20260914001500_catalog_product_model`.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| product_category | a group of products; `key`, `nameKey` | `tenantId` nullable, shared-read | permanent (`isActive`) |
| product | marketing object: `key`, `nameKey`/`descriptionKey`, `fulfilmentKind`, `featureKeys[]`, `defaultQuotas` | `tenantId` nullable, shared-read | permanent (`isActive`) |
| product_variant | the SKU: `quotas` (JSONB by metric), `durationDays` (null = permanent), `billingMode`, `visibility`, `panelGroupId`, `qualityTier` | `tenantId` = its product's, shared-read | permanent (`isActive`) |
| price | a variant's USD `amount` from `effectiveFrom`; append-only | `tenantId` = its variant's, shared-read | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| all four `.tenantId` | -> | tenant.tenant.id | a tenant's own catalog |
| product / product_variant (referenced) | <- | billing.coupon_service_scope.productId / variantId | coupon scope |
| product_variant (referenced) | <- | entitlement.grant.variantId (F-026-b) | what a Grant was issued from |

## Access rules

Read through the tenant's connection (RLS); written by the catalog module in
`billing-service` (F-026-d). A price is found with
`price_variantId_effectiveFrom_idx`: the newest active row at or before the instant.

## Migration notes

`20260914001500` dropped `service_plan` / `service_plan_promotion` and
`product_category.name`, and refuses to run over plan, scope or config rows.
