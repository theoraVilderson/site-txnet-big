---
id: catalog
layer: domain
status: draft
version: 11
updated: 2026-10-13
---

# Contract — catalog: who may buy a product (its audience)

ADR-0142 point 4 (user, 2026-10-13): a product's audience is **every user**
(the default) or **the user groups chosen on it**. Its own file because
[contract.md](contract.md) is at its cap.

Code: `shared-core/src/lib/catalog/audience.ts` (`productsClosedTo`,
`productOpenTo`, `admittedByAudience` — the rule a gateway's audience asks too,
F-102-g), `CatalogAdminService.setProductAudience`. Proof:
`billing-service/src/app/catalog/product-audience.spec.ts`. Storage:
`catalog.product_audience`, migration `20261013000300`.

## The route

| Route | Body | Answer | Refusals |
|---|---|---|---|
| `PUT /api/catalog/products/:id/audience`, and under `/tenants/:tenantId/` (ResellerAccess `staffWrite`) | `userGroupIds[]` (0-50 uuids), the set replaced whole; `[]` = every user | `{userGroupIds}` | `product_not_found` 404 (another tenant's, or the platform's to a reseller), `group_not_found` 400 (a group not the **product's** tenant's — nothing is written), `audience_not_allowed` 403 (a group added that the caller may not pick, governance "A group as an audience", ADR-0143) |

`GET /products` and `GET /products/:id` answer `userGroupIds` beside each
product. A write is audited `catalog_product_update`, `{userGroupIds}` old and
new. It is a write of its own, never part of the product's `PATCH`.

## Rules

| # | Rule | Held by |
|---|---|---|
| 1 | No row = every user, as before; rows = only a user who is a **live user member** (`liveMembership`, ADR-0139 (3)) of at least one group | `productsClosedTo` |
| 2 | Only the **product's own tenant's** buyers are asked. A platform product a reseller sells is bounded by its package (F-019-v5), never by the platform's groups, which hold the platform's users | `productsClosedTo` (`p.tenantId === tenantId`); strict RLS on the rows |
| 3 | The groups are the product's tenant's: composite FKs `(productId, tenantId)` -> `product`, `(groupId, tenantId)` -> `user_group` | FKs; `setProductAudience` refuses first |
| 4 | A group in an audience is not deleted (`group_in_use` 409, RESTRICT); a deleted product takes its rows (CASCADE) | FKs |
| 5 | **Every door asks it, with the buyer:** the shop list (`GET /billing/offers`, `listOffersIn(tx, at, userId)`), a direct link and the bot's buy (`POST /billing/invoices`, `sellableOfferById(…, userId)`), a Grant bought or redeemed (`GrantService.issue`, `variant_not_assignable`) | the readers; the shop and the invoice answer as for a variant that does not exist, never a separate refusal |
| 6 | **An admin's issue by hand asks it too**, staff included (user, 2026-10-13): `not_in_audience` 409 — add the user to a group first. An engagement prize's free Grant goes through the same door | `issueGrantByAdmin` |
| 7 | The users page's issue dialog lists only what may be issued to that user: `GET /billing/tenants/:tenantId/users-catalog?userId=`. Without it the list is whole — a bulk filter picks products already sold | `usersCatalogOf(tx, tenantId, forUser)` |
| 8 | **A Grant already sold is kept** when its owner leaves the group, or the audience changes; a renewal is not a new sale and is never asked. Only new purchases close | nothing reads the audience after issue |
| 9 | A caller with no buyer (a tenant-level reader) applies no audience: `listOffers(at)` / `offerBySku(sku, at)` without `buyer`. **Every caller acting for a user passes it** | `CatalogReadService` |

## The panel

The product sheet has a "who can buy this product" section with its own save
(`ProductAudienceSection.tsx`), shown only for the surface's own tenant's
products — the platform owner's `/catalog` lists every tenant's, but its groups
are the platform's (`ownsAudience`). The groups come from the surface:
`/api/auth/user-groups`, or `/api/auth/tenants/:id/user-groups` in a reseller's
workspace (F-102-g-d). The list marks a limited product "Groups only".
