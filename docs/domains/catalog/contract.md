---
id: catalog
layer: domain
status: draft
version: 4
updated: 2026-09-25
---

# Contract — catalog

**Storage built (F-026-a); reads built (F-026-c), in-process —
`catalog/catalog-reads.ts`, proved by `catalog-reads.spec.ts`; the offer rules
and their `where` fragments live in `shared-core/src/lib/catalog/offers.ts` so
another service asks the same question (F-018-ah); management built
(F-026-d) at `/api/catalog` — `catalog/catalog-admin.*`, proved by
`catalog-admin.service.spec.ts`; the same management for a **named** reseller
(F-066-w7) at `/api/catalog/tenants/:tenantId/...` — `catalog/reseller-catalog.*`,
proved by `reseller-catalog.service.spec.ts`.** Decisions: ADR-0049, ADR-0064, ADR-0073.

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
| `GET /categories` | `archived?` (only `true`: the archived alone; without it they are left out, F-026-l) | the platform's and the caller's own (owner: all), each with `archivedAt` | — |
| `POST /categories`, `PATCH /categories/:id` | `tenantId?` (absent / `null` / uuid), `key`, `sourceLang?`, `name: {lang: text}`; patch `sourceLang`, `name`, `isActive`, `archived: false` (back from the archive, still off) | category | `not_platform_owner` 403, `category_not_found` 404, `key_taken` 409, `lang_unknown` / `source_text_missing` 400, `texts_unavailable` 503 |
| `POST /categories/remove` (F-026-j/l) | `ids[]` (1-100, distinct), `withProducts?` | `[{id, outcome, products?}]`, `outcome` `deleted` / `archived` (only with `withProducts`) / `has_products` / `not_found`, each id on its own; `products: {deleted, archived}` with `withProducts` | — (a refusal is that id's `not_found`) |
| `GET /products` | `categoryId?`, `tenantId?` (owner: uuid or `platform`), `archived?` (only `true`: the archived alone; without it they are left out) | products, each with `archivedAt` | — |
| `POST /products/remove` (F-026-h) | `ids[]` (1-100, distinct) | `[{id, outcome}]`, `outcome` `deleted` / `archived` / `not_found`, each id on its own | — (a refusal is that id's `not_found`) |
| `POST /products`, `GET\|PATCH /products/:id` | `categoryId`, `key`, `sourceLang?`, `name: {lang: text}`, `description?: {lang: text} \| null`, `fulfilmentKind`, `featureKeys?`, `defaultQuotas?`; patch has no key or kind, and `archived: false` brings an archived product back (still off) | product; `GET` with variants and each price history | `category_not_found` (another tenant's category), `product_not_found`, `key_taken`, `lang_unknown`, `source_text_missing`, `texts_unavailable` |
| `POST /products/:id/variants`, `PATCH /variants/:id` | `sku`, `billingMode`, `visibility`, `quotas?`, `durationDays?`, `panelGroupId?`, `qualityTier?`, first `price`; patch has no SKU or billing mode | variant with prices | `variant_not_found`, `sku_taken`, `price_in_the_past`, `panel_group_not_found` (a group that is neither the platform's nor the variant's tenant's, F-027-bk) |
| `GET /panel-groups` (F-026-p) | — | `[{id, tenantId, name, strategy, protocol, healthyMembers}]` by name: the groups a variant may name — the platform's and the caller's own (owner: all, so a variant is offered only the platform's and its own tenant's). `healthyMembers` counts what fulfilment places on now (`placeableMember`: not `drain`, accepted, `healthy`); only `mirror` is fulfilled | — |
| `POST /variants/:id/prices` | `amount`, `effectiveFrom?` (default now; never in the past) | a **new** price row | `variant_not_found`, `price_in_the_past` 400 |
| `POST /prices/:id/deactivate` | — | the price, switched off | `price_not_found` |
| `GET /translations` | `lang?` | drafts: `{lang, key, draft, published, source: {lang, text}}` — the caller's items' (owner: all) | — |
| `POST /translations/draft-missing` | — | `{drafted}` | `texts_unavailable` |
| `POST /translations/publish` | `lang`, `keys[]` (1-200) | `{published}` — drafts as they are | `text_key_invalid` 400, `product_not_found` / `category_not_found` (not the caller's item) |
| `PATCH /translations` | `lang`, `texts: {key: text}` | `{published}` — the reviewer's text, draft dropped | same |

Every write leaves an `admin_audit_log` row (`catalog_*` actions). Nothing is deleted
but a product `POST /products/remove` finds unreferenced (`catalog_product_delete`,
its variants with it), and a category `POST /categories/remove` finds empty
(`catalog_category_delete`). A category any product sits in, an archived one
included, is kept and answered `has_products`: `product.categoryId` is RESTRICT,
so the database decides (`removeCategories`). With `withProducts` (F-026-l)
each product **of the category's own tenant** is removed first as below, then
the category is deleted, or archived (`catalog_category_archive`: off, out of
the list, no new product filed in it) when only archived products remain.
Another tenant's product in the platform's shared category is never touched
and keeps it `has_products`. Restoring a product restores its archived
category, still off. One a Grant, a coupon or a coupon scope references is
archived instead (`catalog_product_archive`): off, out of the list, never sold,
every Grant untouched. The foreign keys decide, so a new table that references
a variant counts without a change (`removeProducts`, invariant 6).
A translation publish is audited as `catalog_product_update` / `catalog_category_update`
on the item it names, `newValue.texts`.

## The same management for a reseller a route names (F-066-w7, ADR-0064)

`/api/catalog/tenants/:tenantId/...` — every route above under that prefix,
`reseller-catalog.*`, proved by `reseller-catalog.service.spec.ts`. The ambient
surface is untouched and stays what a tenant managing its **own** catalog uses.

| Rule | Held by |
|---|---|
| The door is `ResellerAccess` (tenant invariant 21), not `catalog.manage`: a reseller's owner holds no platform permission. `read` for a list, `staffWrite` for a write, judged against the **reseller's** status matrix | `ResellerCatalogService.run` |
| The work runs in the reseller's tenant scope, as the reseller — so every rule above applies unchanged, and the `admin_audit_log` row lands in the reseller's tenant naming the caller as its admin | `ResellerAccess.run` |
| **Nothing is elevated.** `access` answers `owner: false` here for everyone, platform staff included: a platform item is `*_not_found`, and writing one is `not_platform_owner`. The platform's own catalog is managed on the ambient route | actor is a tenant |
| The tenant is the **path's**: `tenantId` is in no body and no query (`.strict()` refuses it), and a create is filed under the admitted reseller | `createResellerCategorySchema`, `createResellerProductSchema`, `listResellerProductsSchema` |
| Refusals: `not_allowed` 403, `reseller_not_found` 404, `reseller_suspended` 403, `reseller_terminated` 409, then every reason above | `ResellerCatalogRefused` |
| One rate-limit bucket per caller across both surfaces — the same person doing the same work (`catalog-admin.rate-limit.ts`) | `CATALOG_ADMIN_READ` / `_WRITE` |

The panel screen over it is F-066-w8.

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
A **metered** variant also carries a `metered_rate` history (F-027-g, ADR-0073):
USD per 2^30 bytes at `Decimal(18,8)`, append-only under
`metered_rate_is_history` exactly as a price is, and read **once, at the moment
of sale** — `GrantService.issue` locks it onto `Grant.meteredRate` (F-027-p), so
a rate written tomorrow never reprices bytes already sold. The unit is
`METERED_RATE_UNIT_BYTES` (shared-core), spelled nowhere else. A rate is
strictly positive (`metered_rate_is_positive`, F-027-al): unlike a price, zero
is not "free" here — no block can be bought at nothing, so the Grant stalls.
Free metered service is a quota with no rate.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `listOffers(at?)` — built | tenant (ambient), instant (default now) | every `public` variant under an active product and category, with the price in effect; a variant with no price is not offered | sync | — |
| `listOffersIn(tx, at)` — built | the caller's `tenantTransaction`, instant | what `listOffers` answers, read in the caller's transaction; each offer carries `panelGroupId` — billing's shop list narrows it to what can be delivered (F-111-e) | sync | — |
| `offerBySku(sku, at?)` — built | sku | the offer, `public` or `unlisted`; the caller's own SKU over the platform's | sync | `null`: unknown, `admin_only`, switched off, or no price |
| `offeredToTenant(tenantId, at)` — built | tenant id, instant | a Prisma `where` for a variant `listOffers` would return to that tenant: `listedVariantWhere`, own or platform row, a price in effect — for a reader on the cross-tenant pool, where RLS does not narrow (F-018-ah) | sync | — |
| `sellableOfferById(tx, variantId, at)` — built | the caller's `tenantTransaction`, variant id, instant | the offer as `offerBySku` would sell it (`public` or `unlisted`, live, priced), read in the caller's transaction — billing's invoice (F-111-a) | sync | `null` |
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
| billing | `coupon_service_scope.productId` / `variantId`: a purchase matches a row naming its variant or its product; `sellableOfferById` + `invoice.variantId` / `priceId` (`Restrict`): what an invoice was priced at (F-111-a) |
| entitlement | a variant's quotas, duration, billing mode and its product's feature keys, copied into a Grant (F-026-b, F-026-e); the metered rate in effect, locked onto `Grant.meteredRate` at issue (F-027-p, ADR-0073) |
| network | a variant's `panelGroupId` (FK to `network.panel_group`, F-027-bk) and `qualityTier` (F-027) |
| tenant | `offeredToTenant`: the onboarding checklist's `pricing` step (F-018-ah) |

## Guarantees (built — `catalog-schema.int.spec.ts`)

| Rule | Held by |
|---|---|
| A tenant reads the platform's rows and its own; it writes only its own | RLS, shared-read (`NULL OR mine` / strictly mine) |
| A product sits in the platform's category or its own tenant's; a variant carries its product's tenant; a price its variant's (`catalog_tenant_mismatch`) | trigger `catalog.same_tenant_as_parent` |
| A price row is never deleted on its own, and only `isActive` changes on it (`price_is_history`); it goes only with its variant's delete (cascade, F-026-h) | trigger `catalog.price_is_history` |
| A category key, a product key and a SKU are unique inside a tenant, and once among platform rows | partial unique indexes |
| A coupon scope row names exactly one product or one variant (`coupon_service_scope_names_one`) | CHECK |
| Money is USD `Decimal(18,2)`, never negative; zero is a free variant | column type + CHECK (ADR-0019, C-02) |
| `visibility`: `public` listed; `unlisted` by SKU only; `admin_only` never sold, only assigned (F-506) | F-026-c |

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `catalog.service_plan`, `catalog.service_plan_promotion`, `ServicePlanBillingModel` | 2026-09-14 | removed in `20260914001500` | `product` / `product_variant` / `price`; campaigns with F-503/F-505 |
