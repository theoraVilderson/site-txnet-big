---
id: panel-web
layer: interface
status: active
version: 25
updated: 2026-09-25
---

# Contract — panel-web: catalog (F-026-f)

A topic file of [contract.md](contract.md) (§10). One page, `/catalog`
(`PANEL_CATALOG`), under `(panel)/catalog/`: `page.tsx` is a server shell,
`_components/CatalogView.tsx` the list and its sheets, `_lib/catalog-form.ts`
the rules. The API is `lib/catalog-api.ts` over `/api/catalog`; the routes, the
scope and every rule are [catalog/contract.md](../../domains/catalog/contract.md)'s
(F-026-d, ADR-0049).

## Rules

1. **The permission hides it; billing scopes it.** The menu entry (`financial`
   group) `requires: ["catalog.manage"]`. What is listed — the platform owner
   every item, a tenant its own and the platform's shared categories — is
   billing's answer; the owner's scope filter only narrows it.
2. **One sentence per refusal.** `REFUSAL_KEYS` is a `Record` over
   `CatalogRejection`; the test reads the union from `catalog-admin.service.ts`.
3. **Every select offers exactly what billing accepts.** The tuples in
   `catalog-api.ts` are test-checked against the Prisma enums and the schema's
   `RESET_POLICIES`.
4. **The forms mirror billing's schema** (`validateProductForm`,
   `validateVariantForm`): key, names, feature keys, SKU (sent
   upper-cased), a price of at most 2 places and never negative, a duration of
   1..3650 days or blank for permanent, a whole-number limit once per metric.
5. **A price is history.** A new price is a new row. Today or blank means from
   now; a later day starts at its first instant in Tehran (`+03:30`); a day
   already past is refused here as billing refuses it. A price is switched off,
   never deleted. "Current" is billing's `priceAt`: the newest active row in
   effect (`currentPrice`).
6. **Nothing is patched from an answer, and two things are deleted.** Every write
   re-reads; variants and prices are switched off, and so is a product one at a
   time. One delete is **a group removal of products** (F-026-i over
   F-026-h): a checkbox per row and "select all" over what the filters show, a
   confirm, then `POST /products/remove` and one line per outcome that happened
   (`removalReport`: deleted, archived because sold, not found). Billing
   decides which — the page never guesses. A read-back drops a selected id the
   list no longer has (`stillSelected`).
6b. **Archived products are behind their own toggle** (`?archived=true`,
   shown only when there are some): named, marked archived, no selection, and
   "restore" (`PATCH archived:false`) brings one back switched off. Their keys
   stay taken, so the wizard counts them.
6c. **Categories are selected the same way, on their own** (F-026-k over
   F-026-j): the categories tab keeps its own selection, never the products'.
   Remove is a confirm, then `POST /categories/remove`. Only if billing
   answers some `has_products` does the page ask again, for those alone
   (`heldByProducts`); a yes resends them `withProducts` (F-026-m over
   F-026-l) and that answer replaces theirs (`mergeRemovals`). One line per
   outcome (`categoryRemovalReport`: deleted, archived with its sold
   products, kept, not found), then the products' own deleted / archived
   counts. An archived category is out of the tab but still names its
   archived products, and comes back when one of them is restored.
6d. **Archived categories are behind their own toggle** (F-026-n, as 6b for
   products): `?archived=true`, shown only when there are some; each named,
   with its archived-product count, no selection, and "restore"
   (`RESTORE_CATEGORY`, `PATCH archived:false`) brings it back switched off. A category's product count includes the archived (`productCounts`),
   because billing keeps a category any of them sits in — a count without them
   would show 0 beside a refusal. Switch on / off is one `PATCH isActive` per
   selected category not already in that state (`switchTargets`), each on its
   own (`allSettled`), then one re-read and a changed / not-changed count
   (`switchReport`).
7. **Buttons stay on the green tokens** (`bg-primary`, `--leaf-bg`).
8. **Names are text, never keys** (F-1533-e/g, ADR-0050 amendments). A
   category or product is created and renamed with a **source language**
   (`LanguageSelect`: every language locale-service has; default
   `DEFAULT_LOCALE`) and one name — and a product's description — in it
   (`validateCategoryForm`, `validateNamesForm`). Picking another language in a
   rename shows its published text. A blank description on a rename removes
   it. Billing derives the key. **Every other language is drafted only when
   "translate into every language" is ticked** (`TranslateAllBox`, F-1533-i),
   off by default on every create and rename sheet and the wizard; unticked,
   `translateAll` is not sent, only the written language changes, and the
   list falls back to the source (rule 9). Ticked, the drafts wait in rule 10.
9. **A list shows the name, not the key.** The page fetches the published
   `catalog` namespace from the panel's own `/api/i18n/<lang>/catalog` for every
   available language and reads the viewer's language, then the item's
   `sourceLang`, then its key (`catalogText`). A failed fetch costs the names,
   never the list.
10. **Review is `/catalog/translations`** (`PANEL_CATALOG_TRANSLATIONS`, linked
   from the catalog header). Each draft sits beside its item's source text and
   what is published now; an untouched draft is published as it is, an edited
   one as the reviewer's text, a blank one never (`reviewWrites`). Languages
   offered are locale-service's — no list in code. "Translate missing" is
   billing's `draft-missing`. Billing scopes every call.
10c. **Categories are a tree, and a product sits in several** (F-026-s over
   F-026-r). The categories tab lists `categoryTree` order — each under its
   parent, indented, siblings by key; one whose parent is not listed shows at
   the top. A new category and "move" (`MoveCategorySheet`, one
   `PATCH parentId` via `moveBody`, blank = top) pick a parent from
   `parentChoices`: never itself or its subtree, never past billing's
   `CATEGORY_MAX_DEPTH` (3, mirrored and checked against shared-core in
   `catalog.test.ts`). A product is filed with `CategoryMultiPicker` (wizard,
   and "change categories" in the product sheet — a patch replaces the list);
   the order picked is the order sent, and at least one is required. Lists and
   the filter name a category by its path (`categoryPath`); the filter matches
   a product in any of its categories. The wizard files a new category under
   the product's owner (`wizardCategoryBody`: platform product → platform
   category) and refuses an existing pick that owner cannot use before any call
   (`categoryNotForOwner`) — billing's `category_not_found` otherwise. A removal answers `has_children` and
   `unlinked` lines too (`categoryRemovalReport`).
10a. **A retired kind is never offered** (F-111-g): the wizard lists
   `CREATABLE_FULFILMENT_KINDS` — `FULFILMENT_KINDS` less billing's
   `RETIRED_FULFILMENT_KINDS` (`wallet_topup`, `external_order` — F-111-h); an existing product still
   shows its kind by name.
10b. **A `network_access` variant names its panel group** (F-026-o over
   F-026-p; no other kind is placed on a panel — `takesPanelGroup`). The
   wizard's variant step, "new variant" and each variant card offer
   `GET /panel-groups` narrowed to the platform's and the variant's own
   tenant's (`groupsForVariant`, as billing's `usableGroup`; the owner's
   wizard reads the tenant from its choice, `wizardVariantTenant`). "None" is
   an answer: the variant is kept, marked "not for sale: no panel group"
   (`notForSale`), and the shop drops it. A card's change is one
   `PATCH panelGroupId` (`panelGroupPatch`, blank = `null`); a create sends a
   group only for `network_access` (`variantBody(form, kind)`). Each option
   shows its owner, protocol, `healthyMembers` and, off `mirror`, "not
   delivered yet". A failed list costs the choices, never the form.

## The same page for a reseller a route names (F-066-w8, ADR-0064 (4))

`/my-resellers/[id]/catalog` and `.../catalog/translations` are these same
components over `/api/catalog/tenants/:id/...` (F-066-w7) —
`my-resellers/[id]/catalog/_components/ResellerCatalogView.tsx`, refusals
`my-resellers/_lib/catalog.ts`. Every rule above holds there unchanged; what
the routes do is [catalog/contract.md](../../domains/catalog/contract.md) "The
same management for a reseller a route names".

11. **One page, two surfaces, chosen by path and never by session**
    (`CatalogSurface`, `catalog/_lib/surface.ts`): `catalogAdminApi(tenantId)`,
    this surface's two hrefs, its chrome and its refusals. It travels by
    **context**, not by prop as the gateway page's does: these calls are made
    four components deep (`VariantCard`, `NewVariant`, `Capabilities`), and a
    prop threaded through all of them is a prop somebody forgets to pass.
12. **The ambient page is never this screen.** A reseller's owner signs in to
    the platform owner's tenant (ADR-0059), so `/catalog` would price the
    **platform's** products and answer 200 doing it. That is why the console's
    pricing step links here (`stepHref`) and why the spec holds the prefix.
13. **Nothing is elevated here** (`surfaceActor`). The actor the forms build a
    body from is `null` on this surface, whoever is signed in: billing runs the
    work as the reseller and its `.strict()` schema refuses a `tenantId`, so
    the owner's scope filter, a shared category and another tenant's product
    are not offered — and never sent — even to platform staff.
14. **One sentence per refusal, on read and on write alike**
    (`CATALOG_REFUSAL_KEYS`, namespace `common.resellerCatalog`, through
    `useMessage`). It covers both doors — `ResellerAccess` and billing's
    catalog rejections — and the spec reads the union from the controller's own
    exhaustive `STATUS` map, so a reason added there has no blank line here.

## Proof

`catalog/catalog.test.ts` — the refusal union and each closed set against its
backend source, `validateProductForm` / `productBody` (reseller vs owner,
feature keys), `validateVariantForm` / `variantBody` (SKU, price, duration,
quotas), `validatePriceForm` / `priceBody` (today, future, past),
`currentPrice`, the menu permission, every key in `en` and `fa`; names
in a source language (`validateCategoryForm` / `categoryBody`,
`validateNamesForm` / `namesBody`, `productBody` never sends a key),
`flattenTexts` / `catalogText` fallback to the source, `reviewWrites`,
`removalReport` / `stillSelected` (F-026-i); `categoryRemovalReport` against
billing's `CategoryRemovalOutcome`, `productCounts`, `switchTargets`,
`switchReport` (F-026-k); `heldByProducts`, `mergeRemovals` and the products'
counts in the report (F-026-m); `RESTORE_CATEGORY` against billing's
`updateCategorySchema` (F-026-n); `takesPanelGroup`, `groupsForVariant`,
`wizardVariantTenant`, `variantBody` by kind, `panelGroupPatch` against
billing's schema, `notForSale` (F-026-o).

`my-resellers/catalog.test.ts` (F-066-w8) — `catalogApiPrefix` on both
surfaces against the controller's own `@Controller`, `surfaceActor` holding a
platform owner's `productBody` / `categoryBody` to nothing elevated, both
doors' refusals against the controller's `STATUS` map, the two paths and the
console's pricing step.
