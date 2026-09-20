---
id: panel-web
layer: interface
status: active
version: 23
updated: 2026-09-20
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
6. **Nothing is patched from an answer, and nothing is deleted.** Every write
   re-reads; products, variants and prices are switched off.
7. **Buttons stay on the green tokens** (`bg-primary`, `--leaf-bg`).
8. **Names are text, never keys** (F-1533-e/g, ADR-0050 amendments). A
   category or product is created and renamed with a **source language**
   (`LanguageSelect`: every language locale-service has; default
   `DEFAULT_LOCALE`) and one name — and a product's description — in it
   (`validateCategoryForm`, `validateNamesForm`). Picking another language in a
   rename shows its published text. A blank description on a rename removes
   it. Billing derives the key and drafts every other language from the source.
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
`flattenTexts` / `catalogText` fallback to the source, `reviewWrites`.

`my-resellers/catalog.test.ts` (F-066-w8) — `catalogApiPrefix` on both
surfaces against the controller's own `@Controller`, `surfaceActor` holding a
platform owner's `productBody` / `categoryBody` to nothing elevated, both
doors' refusals against the controller's `STATUS` map, the two paths and the
console's pricing step.
