---
id: catalog
layer: domain
status: draft
version: 7
updated: 2026-09-28
---

# Contract — catalog

**Storage built (F-026-a); reads built (F-026-c), in-process —
`catalog/catalog-reads.ts`, proved by `catalog-reads.spec.ts`; the offer rules
and their `where` fragments live in `shared-core/src/lib/catalog/offers.ts` so
another service asks the same question (F-018-ah); management built
(F-026-d) at `/api/catalog` — `catalog/catalog-admin.*`, proved by
`catalog-admin.service.spec.ts`; the same management for a **named** reseller
(F-066-w7) at `/api/catalog/tenants/:tenantId/...` — `catalog/reseller-catalog.*`,
proved by `reseller-catalog.service.spec.ts`.** Decisions: ADR-0049, ADR-0064, ADR-0073, ADR-0086, ADR-0098.

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
| `GET /categories` | `archived?` (only `true`: the archived alone; without it they are left out, F-026-l) | the platform's and the caller's own (owner: all), each with `parentId` and `archivedAt` | — |
| `POST /categories`, `PATCH /categories/:id` | `tenantId?` (absent / `null` / uuid), `parentId?` (F-026-r: the platform's or its own tenant's, not archived; `null` = top level), `key`, `sourceLang?`, `name: {lang: text}`, `translateAll?` (F-1533-i); patch `parentId`, `sourceLang`, `name`, `translateAll`, `isActive`, `archived: false` (back from the archive, still off) | category | `category_cycle` 409 (under itself or its own subtree), `category_too_deep` 400 (over `CATEGORY_MAX_DEPTH` = 3 levels, a moved category's subtree counted), `not_platform_owner` 403, `category_not_found` 404 (a parent too), `key_taken` 409, `lang_unknown` / `source_text_missing` 400, `texts_unavailable` 503 |
| `POST /categories/remove` (F-026-j/l/r) | `ids[]` (1-100, distinct), `withProducts?` | `[{id, outcome, products?}]`, `outcome` `deleted` / `archived` (only with `withProducts`) / `has_products` / `has_children` (a category sits under it; nothing touched) / `not_found`, each id on its own; `products: {deleted, archived, unlinked}` with `withProducts` | — (a refusal is that id's `not_found`) |
| `GET /products` | `categoryId?` (filed in it, first or not), `tenantId?` (owner: uuid or `platform`), `archived?` (only `true`: the archived alone; without it they are left out) | products, each with `categoryIds` and `archivedAt` | — |
| `POST /products/remove` (F-026-h) | `ids[]` (1-100, distinct) | `[{id, outcome}]`, `outcome` `deleted` / `archived` / `not_found`, each id on its own | — (a refusal is that id's `not_found`) |
| `POST /products`, `GET\|PATCH /products/:id` | `categoryIds[]` (F-026-r: 1-20, distinct, the first shown first; a patch replaces them all), `key`, `sourceLang?`, `name: {lang: text}`, `description?: {lang: text} \| null`, `translateAll?` (F-1533-i, create and patch), `fulfilmentKind` (never `wallet_topup` — retired, F-111-g: top-ups are the deposit page — nor `external_order` — retired, F-111-h, until a real provider exists; the schema's `RETIRED_FULFILMENT_KINDS`, a 400), `featureKeys?`, `defaultQuotas?`; patch has no key or kind, and `archived: false` brings an archived product back (still off) | product; `GET` with variants and each price history | `category_not_found` (another tenant's category), `capability_unknown` 400 (a `featureKeys` entry that is not the platform's capability or the product's tenant's, F-114-f-a), `product_not_found`, `key_taken`, `lang_unknown`, `source_text_missing`, `texts_unavailable` |
| `GET /capabilities` (F-114-f-a) | — | the platform's and the caller's own (owner: all), each `{id, tenantId, key, nameKey, descriptionKey, sourceLang}` by key | — |
| `POST /capabilities`, `PATCH /capabilities/:id` | `tenantId?`, `key` (the feature-key shape, `vpn.access`), `sourceLang?`, `name`, `description?`, `translateAll?`; patch has no key | capability | `key_taken` 409 (a key the new row's tenant already sees; for a platform row, a key any tenant holds), `not_platform_owner`, `capability_not_found` 404, the text refusals |
| `POST /capabilities/:id/remove` | — | `{id, outcome: 'deleted'}` | `capability_in_use` 409 (a product or a Grant holds the key — a platform one counted across tenants), `capability_not_found` |
| `POST /products/:id/variants`, `PATCH /variants/:id` | `sku`, `billingMode`, `visibility`, `quotas?`, `durationDays?`, `panelGroupId?`, `qualityTier?`, first `price`; patch has no SKU or billing mode | variant with prices | `variant_not_found`, `sku_taken`, `price_in_the_past`, `panel_group_not_found` (a group that is neither the platform's nor the variant's tenant's, F-027-bk), `traffic_quota_required` 400 (F-111-p: a `network_access` + `prepaid` variant with no `quotas.traffic_bytes` — on create, the product's `defaultQuotas` count; on a patch, only one that writes `quotas`). `traffic_bytes.limit: 0` = unlimited; `durationDays: 0` = unlimited, stored `null` |
| `GET /panel-groups` (F-026-p) | — | `[{id, tenantId, name, strategy, protocols, healthyMembers}]` by name (`protocols`: what its members' inbounds sell — each member's assigned ones, else its panel's pool — sorted, F-114-b, F-027-ch; empty = nothing is placed): the groups a variant may name — the platform's and the caller's own (owner: all, so a variant is offered only the platform's and its own tenant's). `healthyMembers` counts what fulfilment places on now (`placeableMember`: not `drain`, accepted, `healthy`); only `mirror` is fulfilled | — |
| `POST /variants/:id/prices` | `amount`, `effectiveFrom?` (default now; never in the past) | a **new** price row, `currencyCode` its tenant's operating currency (the platform's for a platform variant) — the amount is taken as typed, never converted (F-116-d) | `variant_not_found`, `price_in_the_past` 400 |
| `POST /prices/:id/deactivate` | — | the price, switched off | `price_not_found` |
| `GET /translations` | `lang?` | drafts: `{lang, key, draft, published, source: {lang, text}}` — the caller's items' (owner: all) | — |
| `POST /translations/draft-missing` | — | `{drafted}` | `texts_unavailable` |
| `POST /translations/publish` | `lang`, `keys[]` (1-200) | `{published}` — drafts as they are | `text_key_invalid` 400, `product_not_found` / `category_not_found` (not the caller's item) |
| `PATCH /translations` | `lang`, `texts: {key: text}` | `{published}` — the reviewer's text, draft dropped | same |

Every write leaves an `admin_audit_log` row (`catalog_*` actions). Nothing is deleted
but a product `POST /products/remove` finds unreferenced (`catalog_product_delete`,
its variants with it), and a category `POST /categories/remove` finds empty
(`catalog_category_delete`). A category any product sits in, an archived one
included, is kept and answered `has_products`: `product_category_link.categoryId`
is RESTRICT, so the database decides (`removeCategories`); one a category sits
under is `has_children`, checked first. With `withProducts` (F-026-l)
each product **of the category's own tenant** is removed first as below — one
filed in another category too is only taken out of this one (`unlinked`,
audited `catalog_product_update`) — then
the category is deleted, or archived (`catalog_category_archive`: off, out of
the list, no new product filed in it) when only archived products remain.
Another tenant's product in the platform's shared category is never touched
and keeps it `has_products`. Restoring a product restores each archived
category it sits in, still off. One a Grant, a coupon or a coupon scope references is
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

The panel screen over it is F-066-w8. The capability routes are there too.

## Capabilities (F-114-f-a, ADR-0086)

A product's `featureKeys` are keys of `product_capability` rows; a Grant still
copies the strings (`catalog/catalog-admin.service.ts`, proved by
`catalog-admin.service.spec.ts` and `catalog-schema.int.spec.ts`).

| Rule | Held by |
|---|---|
| A product may carry the platform's capabilities and its own tenant's, judged by the **product's** tenant (the owner writing a tenant's product sees no more) | `knownCapabilities` |
| The check locks those rows `FOR SHARE`; a delete locks its row `FOR UPDATE`, then counts products and Grants holding the key — so neither slips past the other | `knownCapabilities`, `removeCapability` |
| A key is unique among what one tenant sees: a tenant's never repeats the platform's, nor the platform's a tenant's | partial unique indexes + trigger `capability_key_free` |
| The key never changes; the name is text of kind `capability` (`catalog.[t_<hex>.]capability.<key>.name`), reviewed like a product's | `catalogTextKey`, `TEXT_ITEMS` |
| A row the migration wrote from a key in use has no text: a reader falls back to the key | migration `20260925001400` |

## Names (F-1533-d/f, ADR-0050 and its amendments)

A category or product body carries **text, never a key**; `nameKey` /
`descriptionKey` are derived and returned (`catalog/catalog-texts.ts`, proved by
`catalog-texts.spec.ts` and `catalog-admin.service.spec.ts`).

| Rule | Held by |
|---|---|
| Key = `catalog.[t_<tenant hex>.]<category\|product>.<key>.<name\|description>` — a tenant's under its own prefix, the platform's plain | `catalogTextKey` |
| An item has a `sourceLang` (column, nullable = `DEFAULT_LANGUAGE`; the view always resolves it): absent on a create → `DEFAULT_LANGUAGE`; any language locale-service has, else `lang_unknown`; `name` (and a `description`) must hold its text, else `source_text_missing`; a new `sourceLang` on a patch needs `name` | `sourceLang` |
| Every language written is published inside the write's transaction: locale-service down → `texts_unavailable` 503, row rolled back | `publishSources` |
| **Only a write with `translateAll: true`** (F-1533-i; off when absent) drafts every language not written **from the source language** after commit, published ones included — they wait in the review list; a failing engine or store costs the draft, never the write. Without it only the languages written change, and a reader falls back to the source | `draftOthers` |
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
in its `currencyCode` from `effectiveFrom` on, and a change is a new row. `tenantId IS NULL` is the
platform's row, readable by every tenant. Names are i18n keys (§4.3).
A **meter** (F-118-c, ADR-0105) is what is counted and billed on use: a
platform-only `meter` row, written by a migration because a meter exists only
where code reports it — seeded `vpn.traffic` (bytes). Code names it through
`METER_KEYS` (`shared-core/src/lib/catalog/meter.ts`).
A **rate card** (F-118-d, ADR-0105 decision 3) prices one meter on one variant:
`unitPrice` per `unitSize` of the meter's unit, `Decimal(18,8)`, in its
`currencyCode`; `mode` `prepaid | postpaid`, picked by the seller per meter;
`includedQuantity` paid with the plan, then `afterIncluded` `stop | metered`.
Append-only under `rate_card_is_history` exactly as a price is; a tenant writes
cards on its own variants only. A metered unit costs more than zero
(`rate_card_metered_price_positive`, F-027-al: no block is bought at nothing);
free usage is an included quantity that stops. Read **once, at the moment of
sale** (`rateCardAt`): a card written tomorrow never reprices what was sold.
Every `metered_rate` row became a `vpn.traffic` prepaid card per 2^30 bytes
(`METERED_RATE_UNIT_BYTES`); F-118-l dropped `metered_rate`. No route writes a card yet (F-118-m, with the mode).
Every card in effect is locked on the Grant as a `grant_meter` row (F-118-e,
entitlement `contract.md`); a VPN Grant still sells only a card the byte engine
serves — per 2^30 bytes, nothing included, then metered; prepaid or, since
F-118-k, postpaid (`vpnTrafficRateAt`); a newer card of any other shape is no rate, so the sale
is refused (`metered_rate_missing`), never made at the older card.

## Currency (F-116-d, ADR-0098 part 2)

`catalog/catalog-reads.ts`, `shared-core/src/lib/catalog/offers.ts`, proved by
`catalog/price-currency.spec.ts`.

| Rule | Held by |
|---|---|
| A `price` and a `rate_card` row record `currencyCode`: its tenant's operating currency when written, the platform's for a platform row. NOT NULL, no default; rows from before are `USD` | migration `20260928002600`, `pricingCurrencyOf` |
| **A reader takes only the rows in the reading tenant's operating currency.** A platform row in another currency is no price for that tenant — the variant is not offered, as one with no price is not; never converted (user, 2026-09-28) | `effectiveIn` under `priceAt` / `rateCardAt`; `pricesInEffect(at, code)` / `rateCardsInEffect(at, code, meterKey)` |
| An offer carries `price.currencyCode`; an invoice copies it | `toOffer`, `InvoiceService.create` |
| A Grant locks the rate's currency with the rate; a block and a remainder move in it | `grantFromVariant`, entitlement invariant 10 |
| A currency change writes new rows in the new currency (F-116-f) — a rate card per meter, every column but price and currency kept; the old ones stop matching and stay as history | `repriceRateCards` (F-118-d) |

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `listOffers(at?)` — built | tenant (ambient), instant (default now) | every `public` variant under an active product filed in at least one live category (it and every one above it on — `category-tree.ts`, F-026-r), with the price in effect in the tenant's currency; a variant with no such price is not offered | sync | — |
| `listOffersIn(tx, at)` — built | the caller's `tenantTransaction`, instant | what `listOffers` answers, read in the caller's transaction; each offer carries `panelGroupId` — billing's shop list narrows it to what can be delivered (F-111-e) | sync | — |
| `offerBySku(sku, at?)` — built | sku | the offer, `public` or `unlisted`; the caller's own SKU over the platform's | sync | `null`: unknown, `admin_only`, switched off, or no price |
| `offeredToTenant(tenantId, at, currencyCode)` — built | tenant id, instant, its operating currency (F-116-d) | a Prisma `where` for a variant `listOffers` would return to that tenant: `listedVariantWhere`, own or platform row, a price in effect — for a reader on the cross-tenant pool, where RLS does not narrow (F-018-ah) | sync | — |
| `sellableOfferById(tx, variantId, at)` — built | the caller's `tenantTransaction`, variant id, instant | the offer as `offerBySku` would sell it (`public` or `unlisted`, live, priced), read in the caller's transaction — billing's invoice (F-111-a) | sync | `null` |
| `priceAt(variantId, at)` — built | variantId, instant | the newest active price row in the tenant's currency with `effectiveFrom <= at` (F-0602, F-116-d) | sync | `null` |
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
| entitlement | a variant's quotas, duration, billing mode and its product's feature keys, copied into a Grant (F-026-b, F-026-e); the `vpn.traffic` rate card in effect, locked as the Grant's `vpn.traffic` `grant_meter` at issue (ADR-0073; `vpnTrafficRateAt`, F-118-d; its only rate since F-118-l) |
| network | a variant's `panelGroupId` (FK to `network.panel_group`, F-027-bk) and `qualityTier` (F-027) |
| tenant | `offeredToTenant`: the onboarding checklist's `pricing` step (F-018-ah) |

## Guarantees (built — `catalog-schema.int.spec.ts`)

| Rule | Held by |
|---|---|
| A tenant reads the platform's rows and its own; it writes only its own | RLS, shared-read (`NULL OR mine` / strictly mine) |
| A product is filed (`product_category_link`, carrying its tenant) in the platform's categories or its own tenant's; a variant carries its product's tenant; a price its variant's (`catalog_tenant_mismatch`) | triggers `catalog.category_link_ok`, `catalog.same_tenant_as_parent` |
| A category sits under the platform's or its own tenant's, never under itself or its subtree (`category_cycle`, one re-parent at a time); a parent with children is RESTRICT. The depth cap is code, not schema | trigger `catalog.category_parent_ok` (F-026-q) |
| A price row is never deleted on its own, and only `isActive` changes on it (`price_is_history`); it goes only with its variant's delete (cascade, F-026-h) | trigger `catalog.price_is_history` |
| A category key, a product key and a SKU are unique inside a tenant, and once among platform rows | partial unique indexes |
| A coupon scope row names exactly one product or one variant (`coupon_service_scope_names_one`) | CHECK |
| Money is `Decimal(18,2)` in the row's `currencyCode` (`^[A-Z]{3}$`), never negative; zero is a free variant | column type + CHECKs (ADR-0098, C-02) |
| A meter is a platform row every tenant reads and no service role writes; its `key` and `unit` never change, even for the owner (`meter_is_immutable`) — F-118-c | grants (SELECT only), trigger `catalog.meter_is_immutable` |
| A rate card is history (`rate_card_is_history`), carries its variant's tenant, names a meter that exists (FK on `meter.key`); a metered unit is priced above zero and a `stop` card includes some (`rate_card_stop_includes_some`) — F-118-d | triggers, FKs, CHECKs |
| `visibility`: `public` listed; `unlisted` by SKU only; `admin_only` never sold, only assigned (F-506) | F-026-c |

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `catalog.service_plan`, `catalog.service_plan_promotion`, `ServicePlanBillingModel` | 2026-09-14 | removed in `20260914001500` | `product` / `product_variant` / `price`; campaigns with F-503/F-505 |
