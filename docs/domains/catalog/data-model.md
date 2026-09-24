---
id: catalog
layer: domain
updated: 2026-09-21
---

# Data model — catalog

Source of truth: `txnet-backend/prisma/domains/catalog.prisma` (Postgres schema
`catalog`), migration `20260914001500_catalog_product_model`.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| product_category | a group of products; `key`, `nameKey` | `tenantId` nullable, shared-read | permanent (`isActive`) |
| product | marketing object: `key`, `nameKey`/`descriptionKey`, `fulfilmentKind`, `featureKeys[]`, `defaultQuotas` | `tenantId` nullable, shared-read | permanent (`isActive`) |
| product_variant | the SKU: `quotas` (JSONB by metric), `durationDays` (null = permanent), `billingMode`, `visibility`, `panelGroupId` (FK `network.panel_group`, a platform group or its own tenant's — F-027-bk), `qualityTier` | `tenantId` = its product's, shared-read | permanent (`isActive`) |
| price | a variant's USD `amount` from `effectiveFrom`; append-only | `tenantId` = its variant's, shared-read | permanent |
| metered_rate | a variant's USD `rate` per 2^30 bytes from `effectiveFrom`, `Decimal(18,8)`, strictly positive; append-only (F-027-g) | `tenantId` = its variant's, shared-read | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| all five `.tenantId` | -> | tenant.tenant.id | a tenant's own catalog |
| product / product_variant (referenced) | <- | billing.coupon_service_scope.productId / variantId | coupon scope |
| product_variant (referenced) | <- | entitlement.grant.variantId (F-026-b) | what a Grant was issued from |
| metered_rate (read at sale) | -> | entitlement.grant.meteredRate (F-027-p) | the rate is copied onto the Grant at issue (ADR-0073) |

## Access rules

Read through the tenant's connection (RLS); written by the catalog module in
`billing-service` (F-026-d). A price is found with
`price_variantId_effectiveFrom_idx`: the newest active row at or before the instant.
A metered rate is found the same way, on `metered_rate_variantId_effectiveFrom_idx`,
once at the moment of sale — never at consumption time (ADR-0073).

## Migration notes

`20260921000700` added `metered_rate` (additive: one table, nothing reads it
until F-027-p); `20260922000100` tightened its CHECK from `>= 0` to `> 0`
(F-027-al) — free metered service is a quota with no rate, not a rate of zero,
which no block purchaser can buy from. `20260914001500` dropped `service_plan` / `service_plan_promotion` and
`product_category.name`, and refuses to run over plan, scope or config rows.
