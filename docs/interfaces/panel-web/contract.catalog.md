---
id: panel-web
layer: interface
status: active
version: 18
updated: 2026-09-16
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

## Proof

`catalog/catalog.test.ts` — the refusal union and each closed set against its
backend source, `validateProductForm` / `productBody` (reseller vs owner,
feature keys), `validateVariantForm` / `variantBody` (SKU, price, duration,
quotas), `validatePriceForm` / `priceBody` (today, future, past),
`currentPrice`, the menu permission, every key in `en` and `fa`; names
in a source language (`validateCategoryForm` / `categoryBody`,
`validateNamesForm` / `namesBody`, `productBody` never sends a key),
`flattenTexts` / `catalogText` fallback to the source, `reviewWrites`.
