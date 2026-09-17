---
id: catalog
layer: domain
status: draft
version: 2
updated: 2026-09-16
---

# Contract — catalog

**Storage built (F-026-a); reads built (F-026-c), in-process —
`catalog/catalog-reads.ts`, proved by `catalog-reads.spec.ts`; management built
(F-026-d) at `/api/catalog` — `catalog/catalog-admin.*`, proved by
`catalog-admin.service.spec.ts`.** Decision: ADR-0049.

## HTTP surface (F-026-d)

`/api/catalog`, served by billing-service on its own Traefik route (the
user's call, 2026-09-14), behind `my-auth`, `catalog.manage`
(`CatalogPermissionGuard`, first door only) and per-user budgets
`CATALOG_ADMIN_READ` / `CATALOG_ADMIN_WRITE` (120 / 30 per 15 min). The
platform owner manages platform items and any tenant's; any other tenant its
own — another tenant's item, or the platform's, answers 404. **The pool
follows the caller (ADR-0053, F-102-f-c):** the platform owner on the
cross-tenant pool; any other tenant in a `tenantTransaction` on the app pool,
so RLS stands behind that rule. A tenant admin reads nothing on the
cross-tenant pool.

| Route | Body / query | Answer | Refusals |
|---|---|---|---|
| `GET /categories` | — | the platform's and the caller's own (owner: all) | — |
| `POST /categories`, `PATCH /categories/:id` | `tenantId?` (absent / `null` / uuid), `key`, `sourceLang?`, `name: {lang: text}`; patch `sourceLang`, `name`, `isActive` | category | `not_platform_owner` 403, `category_not_found` 404, `key_taken` 409, `lang_unknown` / `source_text_missing` 400, `texts_unavailable` 503 |
| `GET /products` | `categoryId?`, `tenantId?` (owner: uuid or `platform`) | products | — |
| `POST /products`, `GET\|PATCH /products/:id` | `categoryId`, `key`, `sourceLang?`, `name: {lang: text}`, `description?: {lang: text} \| null`, `fulfilmentKind`, `featureKeys?`, `defaultQuotas?`; patch has no key or kind | product; `GET` with variants and each price history | `category_not_found` (another tenant's category), `product_not_found`, `key_taken`, `lang_unknown`, `source_text_missing`, `texts_unavailable` |
| `POST /products/:id/variants`, `PATCH /variants/:id` | `sku`, `billingMode`, `visibility`, `quotas?`, `durationDays?`, `panelGroupId?`, `qualityTier?`, first `price`; patch has no SKU or billing mode | variant with prices | `variant_not_found`, `sku_taken`, `price_in_the_past` |
| `POST /variants/:id/prices` | `amount`, `effectiveFrom?` (default now; never in the past) | a **new** price row | `variant_not_found`, `price_in_the_past` 400 |
| `POST /prices/:id/deactivate` | — | the price, switched off | `price_not_found` |
| `GET /translations` | `lang?` | drafts: `{lang, key, draft, published, source: {lang, text}}` — the caller's items' (owner: all) | — |
| `POST /translations/draft-missing` | — | `{drafted}` | `texts_unavailable` |
| `POST /translations/publish` | `lang`, `keys[]` (1-200) | `{published}` — drafts as they are | `text_key_invalid` 400, `product_not_found` / `category_not_found` (not the caller's item) |
| `PATCH /translations` | `lang`, `texts: {key: text}` | `{published}` — the reviewer's text, draft dropped | same |

Every write leaves an `admin_audit_log` row (`catalog_*` actions). Nothing is deleted.
A translation publish is audited as `catalog_product_update` / `catalog_category_update`
on the item it names, `newValue.texts`.

## Names (F-1533-d/f, ADR-0050 and its amendments)

A category or product body carries **text, never a key**; `nameKey` /
`descriptionKey` are derived and returned (`catalog/catalog-texts.ts`, proved by
`catalog-texts.spec.ts` and `catalog-admin.service.spec.ts`).

| Rule | Held by |
|---|---|
| Key = `catalog.[t_<tenant hex>.]<category\|product>.<key>.<name\|description>` — a tenant's under its own prefix, the platform's plain | `catalogTextKey` |
| An item has a `sourceLang` (column, nullable = `DEFAULT_LANGUAGE`; the view always resolves it): absent on a create → `DEFAULT_LANGUAGE`; any language locale-service has, else `lang_unknown`; `name` (and a `description`) must hold its text, else `source_text_missing`; a new `sourceLang` on a patch needs `name` | `sourceLang` |
| Every language written is published inside the write's transaction: locale-service down → `texts_unavailable` 503, row rolled back | `publishSources` |
| Every language not written gets a draft **from the source language** after commit; a failing engine or store costs the draft, never the write | `draftOthers` |
| A catalog reader falls back: requested language → the item's `sourceLang` → key (not the clients' en → fa) | readers (panel F-1533-g) |
| "Translate missing" drafts from each item's source, only a language with neither published text nor a pending draft; the review list is the caller's items' keys (owner: all) | `draftMissing`, `textSourcesOf` |
| A draft is published, or edited and published, only by whoever manages the item its key names | `publishingTexts` |
| An edited name re-keys the row to the derived key; `description: null` clears the key and its text in every language | `updateProduct`, `clear` |
| Variant `nameKey` is still free input and writes no text | — (not in F-1533) |

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
| i18n | `SetEntries` / `ListDrafts` / `PublishDrafts`, the `catalog` namespace (F-1533-b) | name writes refuse `texts_unavailable`; drafts skipped |
| i18n | `Translator` (F-1533-a), `TRANSLATOR_URL` | no drafts |

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
