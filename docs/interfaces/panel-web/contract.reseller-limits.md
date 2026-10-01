---
id: panel-web
layer: interface
status: active
version: 41
updated: 2026-10-01
---

# Contract — panel-web: reseller limits (F-019-r, ADR-0106; F-019-v9, ADR-0107)

A §10 split of [contract.resellers.md](contract.resellers.md), which is at its
ceiling. The routes and their rules are tenant's
(`domains/tenant/contract.limits.md`); this is the page over them.

## Where

- `/resellers/limits` (`PANEL_RESELLER_LIMITS`, `resellers/limits/_components/LimitsView.tsx`),
  reached from **Limits** on `/resellers`. Platform owner only, as `/resellers`
  (`canAdministerResellers`); anyone else sees `not_platform_owner` and nothing is asked.
- On `/resellers/[id]`, overview tab: **Limits** (`LimitsSection`) — each key in
  effect for that reseller and where it comes from, with a link to the page.

`lib/tenant-api.ts` `resellerLimitsApi`: `table`, `ofReseller`, `setPlatform` /
`clearPlatform`, `setPackage` / `clearPackage`, `setResellers` / `clearResellers`; past a
quota, `setPlatformOverage` / `clearPlatformOverage`, `setPackageOverage` /
`clearPackageOverage`, `clearResellersOverage`; a package's products,
`packageProducts`, `setPackageProduct`, `clearPackageProduct` (F-019-v9).

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | One card per key, in `RESELLER_LIMIT_KEYS` — shared-core's `RESELLER_LIMITS` in its order; the spec reads that file and holds the two together | a key added there with no card here is a limit nobody can set |
| 2 | Every value shown is tenant-service's answer: the table for the page, `GET /tenants/:id/limits` for one reseller (`limit`, `source`). Nothing here decides which level wins. After a save the table is read again | the resolver is the only place the order of levels lives |
| 3 | Each level shows what it holds: a number, **no limit** (`null`), or **not set** (no row — the next level applies). "Back to the next level" (`clear…`) is offered only where the level has a row | no limit and not set are different decisions |
| 4 | A value is a whole number within the key's `max`, or "no limit" ticked → `null` (`limitValueOf`); anything else keeps save off. An empty box is never 0 | 0 refuses everything |
| 5 | **For chosen resellers**: one request for every ticked reseller (from `tenantApi.resellers(100, 0)`), the value and a reason — the button waits for at least one reseller and a reason; tenant-service writes all or none | ADR-0106 "several resellers"; the reason is kept on each row and audit |
| 6 | A reseller's own value is listed with its reason and removed alone (`clearResellers(key, [id])`) | a reseller's limit stays that reseller's |
| 7 | Refusals are tenant-service's sentence (`useMessage`), on the card that asked | `unknown_limit`, `limit_out_of_range`, `package_not_found`, `reseller_not_found` |

## Past a quota, and a package's products (F-019-v9, ADR-0107 points 2, 3)

Files: `limits/_components/QuotaOverage.tsx`, `PackageProducts.tsx`; the pure
parts in `resellers/_lib/limits.ts`.

| # | Rule | Why |
|---|---|---|
| 12 | Only a `kind: "quota"` card shows **Past what is included** (`QuotaOverage`): the platform's answer and each package's — **refused**, **{price} {currency} per extra unit**, or **not set** — each saved and cleared on its own, and a reseller's own answer listed with its reason and removed alone (`clearResellersOverage`). A guard card has none | a guard is never sold past (ADR-0107 point 1); the service would answer `not_a_quota` |
| 13 | A price is sent as the string typed (`unitPriceOf`): positive, at most two places, never 0. `overageBodyOf` sends `{mode: "stop"}` with no price; save stays off until the body is valid | C-02; the route is strict and 0 is not a price |
| 14 | **Platform products each package sells** (`PackageProducts`): one package picked, then every platform product (`catalogApi.products()`, `tenantId` null — a reseller's own are not the platform's to list) named from the catalog's texts, each **sold** with its terms or **not sold by this package** | a product a package does not list is unsellable by its resellers (F-019-v5); the owner must see what is missing, not only what is there |
| 15 | A product's terms are sent whole each time (`productQuotaBodyOf`): day / week / month each a whole number up to 10 000 000 or **blank = no bound** (left out, never 0); `overage` only when selling past. Listing an unlisted product is the same `PUT` | 0 includes nothing — every sale overage or refused; the route replaces the whole terms |
| 16 | **Take off this package** asks first (`window.confirm`), saying resellers already on it keep selling on their terms until their paid period ends | it is held for the period (F-019-v6), so the owner should not expect it gone at once |
| 17 | After any save the table, or the package's list, is read again; refusals are the service's sentence on the card or product that asked | rule 2 |

## The reseller's own (F-019-s)

On its workspace console (`/my-resellers/:id`, `ResellerLimitsCard`), under
the operating currency: each key, what is used and where the limit comes from.

| # | Rule | Why |
|---|---|---|
| 8 | By the path's reseller (`ofReseller(id)`), never the session's tenant; tenant-service admits the owner, its team and platform staff | ADR-0064, invariant 21 |
| 9 | `limitReading` reads `limit` and `used` as they came: a count against a limit (a bar, **Full** at or past it), a count with no limit, `used: null` as "up to N" (a key that counts nothing), both null as no limit. Nothing is counted here | the count is the refusal's own (`tenant/contract.limits.md` "What is used") |
| 10 | Read-only; the card says a limit is raised by a ticket | the platform sets limits, the reseller does not |
| 11 | A `reseller_limit_reached` refusal is said once, in `useApiErrorMessage` (`lib/reseller-limits.ts` `resellerLimitReachedOf`): the key's name from this page, `used` and `limit` from `facts`; a ceiling (`bulk_job_grants_max`) as "at most `limit`, this asks `used`". A key the panel does not know, figures that are not numbers, or `user_metered_cap_max` (its `used` is the number asked; billing's own sentence) keep the server's text | billing and tenant refuse with figures only; every screen gets the name without its own copy |

## Proof

`resellers/limits.test.tsx` — the keys against shared-core's file, `limitValueOf`,
each level's value from the table, the platform's saved as a number and as
no limit, several resellers only with someone picked and a reason, one
reseller's own value removed, nobody but the platform owner; `unitPriceOf`,
`overageBodyOf`, `productQuotaBodyOf`, a quota's overage per level (none on a
guard), a package's products re-termed and taken off.
`my-resellers/limits.test.tsx` — `limitReading` for each shape, the card for
the path's reseller, the refusal sentence and when the server's text stays.

## Not covered

More than 100 resellers to pick from (the list asks one page). An overage
answer **set** for chosen resellers (`PUT …/resellers/:key/overage`) is not on
the page; one already set is shown and removable.
