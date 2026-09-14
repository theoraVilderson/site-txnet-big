---
id: catalog
layer: domain
status: draft
version: 2
updated: 2026-09-14
---

# Contract — catalog

**Storage built (F-026-a); reads built (F-026-c), in-process only —
`catalog/catalog-reads.ts`, proved by `catalog-reads.spec.ts`.** Management
lands with F-026-d. Decision: ADR-0049.

## TL;DR

`product_category → product → product_variant → price`. A **product** is the
marketing object and says how it is fulfilled (`fulfilmentKind`) and what a
Grant of it unlocks (`featureKeys`); a **variant** is the SKU that is sold, with
its quotas, duration and visibility; a **price** is the variant's USD amount
from `effectiveFrom` on, and a change is a new row. `tenantId IS NULL` is the
platform's row, readable by every tenant. Names are i18n keys (§4.3).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `listOffers(at?)` — built | tenant (ambient), instant (default now) | every `public` variant under an active product and category, with the price in effect; a variant with no price is not offered | sync | — |
| `offerBySku(sku, at?)` — built | sku | the offer, `public` or `unlisted`; the caller's own SKU over the platform's | sync | `null`: unknown, `admin_only`, switched off, or no price |
| `priceAt(variantId, at)` — built | variantId, instant | the newest active price row with `effectiveFrom <= at` (F-0602) | sync | `null` |
| manage category / product / variant, write a new price | admin payload, `catalog.manage` | row (F-026-d) | sync | — |

## Emits (events)

None.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | the ambient tenant (ADR-0024) | refuses |

## Consumers

| Unit | What it reads |
|---|---|
| billing | `coupon_service_scope.productId` / `variantId`: a purchase matches a row naming its variant or its product |
| entitlement | a variant's quotas, duration, billing mode and its product's feature keys, copied into a Grant (F-026-b, F-026-e) |
| network | a variant's `panelGroupId` and `qualityTier` (F-027) |

## Guarantees (built — `catalog-schema.int.spec.ts`)

| Rule | Held by |
|---|---|
| A tenant reads the platform's rows and its own; it writes only its own | RLS, shared-read (`NULL OR mine` / strictly mine) |
| A product sits in the platform's category or its own tenant's; a variant carries its product's tenant; a price its variant's (`catalog_tenant_mismatch`) | trigger `catalog.same_tenant_as_parent` |
| A price row is never deleted, and only `isActive` changes on it (`price_is_history`) | trigger `catalog.price_is_history` |
| A category key, a product key and a SKU are unique inside a tenant, and once among platform rows | partial unique indexes |
| A coupon scope row names exactly one product or one variant (`coupon_service_scope_names_one`) | CHECK |
| Money is USD `Decimal(18,2)`, never negative; zero is a free variant | column type + CHECK (ADR-0019, C-02) |
| `visibility`: `public` listed; `unlisted` by SKU only; `admin_only` never sold, only assigned (F-506) | F-026-c |

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `catalog.service_plan`, `catalog.service_plan_promotion`, `ServicePlanBillingModel` | 2026-09-14 | removed in `20260914001500` | `product` / `product_variant` / `price`; campaigns with F-503/F-505 |
