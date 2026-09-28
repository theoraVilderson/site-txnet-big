---
id: catalog
layer: domain
updated: 2026-09-28
---

# Data model — catalog

Source of truth: `txnet-backend/prisma/domains/catalog.prisma` (Postgres schema
`catalog`), migration `20260914001500_catalog_product_model`.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| product_category | a group of products; `key`, `nameKey`, `parentId` (self FK, RESTRICT, F-026-q) | `tenantId` nullable, shared-read | permanent (`isActive`) |
| product_category_link | a product filed in a category; PK (`productId`, `categoryId`), `position` (0 first); product CASCADE, category RESTRICT (F-026-q) | `tenantId` = its product's, shared-read | as long as its product |
| product_capability | what a product may unlock (F-114-f-a): `key` (immutable, unique among what one tenant sees — trigger `capability_key_free`), `nameKey`/`descriptionKey`, `sourceLang` | `tenantId` nullable, shared-read | deletable only while no product or Grant holds its key |
| product | marketing object (its categories are `product_category_link`, F-026-q): `key`, `nameKey`/`descriptionKey`, `fulfilmentKind`, `featureKeys[]`, `defaultQuotas`, `archivedAt` | `tenantId` nullable, shared-read | deletable with its variants until one is referenced, then permanent (`isActive`, `archivedAt`) — F-026-h |
| product_variant | the SKU: `quotas` (JSONB by metric), `durationDays` (null = permanent), `billingMode`, `visibility`, `panelGroupId` (FK `network.panel_group`, a platform group or its own tenant's — F-027-bk), `qualityTier` | `tenantId` = its product's, shared-read | permanent (`isActive`) |
| price | a variant's `amount` in its `currencyCode` (F-116-d) from `effectiveFrom`; append-only | `tenantId` = its variant's, shared-read | as long as its variant (FK `ON DELETE CASCADE`) |
| metered_rate | a variant's `rate` per 2^30 bytes in its `currencyCode` from `effectiveFrom`, `Decimal(18,8)`, strictly positive; append-only (F-027-g) | `tenantId` = its variant's, shared-read | permanent |

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

`20260928002600` (F-116-d) added `currencyCode` to `price` and `metered_rate` (backfilled `USD`, then no default) and `entitlement.grant.meteredRateCurrencyCode` (`USD` where a rate is set). `20260925001400` added `product_capability` and wrote one row per key in use: a key any platform product carries is the platform's, any other a row of each tenant whose product or Grant holds it; only keys in the `vpn.access` shape. `20260921000700` added `metered_rate` (additive: one table, nothing reads it
until F-027-p); `20260922000100` tightened its CHECK from `>= 0` to `> 0`
(F-027-al) — free metered service is a quota with no rate, not a rate of zero,
which no block purchaser can buy from. `20260914001500` dropped `service_plan` / `service_plan_promotion` and
`product_category.name`, and refuses to run over plan, scope or config rows.
