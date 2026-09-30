---
id: panel-web
layer: interface
status: active
version: 41
updated: 2026-09-30
---

# Contract — panel-web: the packages the platform sells resellers (F-118-n5)

`/resellers/packages` (`PANEL_RESELLER_PACKAGES`), files under
`resellers/packages/` and `resellers/_lib/packages.ts`. The panel half of the
package routes — `GET/POST /api/tenant-packages`, `PATCH /:id`, `POST /:id/apply`
(producer: [tenant/contract.admin.md](../../domains/tenant/contract.admin.md)
"Packages", F-018-d/o, F-118-n1), and an unlimited plan's flat wholesale price
(F-118-aa, D-59 (c)). Reached from **Packages** on `/resellers`; no
menu entry of its own — the path is under `PANEL_RESELLERS`, so that entry stays
lit, and the static segment wins over `[id]` as `/buy` does. Built whole on the
user's answer (2026-09-29): a negotiated deal is a package of its own, so creating
one is routine and a rates-only page would have left it to the API.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | Who may open it is `canAdministerResellers` (`tenant.manage` + the platform owner's tenant) — the same two conditions as `/resellers`. A reseller that typed the path gets `not_platform_owner`'s sentence and no read | a reseller can grant itself `tenant.manage`; the service would refuse it anyway |
| 2 | The list is every package, active or withdrawn, as `GET /tenant-packages` answers it: name, the two prices (`formatMoney` in the package's `currencyCode`), the wholesale rates — per GiB, and per 30 days of unlimited when set — the features by name, on sale / withdrawn | a reseller may stay on a withdrawn package, so it stays visible and editable |
| 3 | **Create and edit are one sheet.** Create sends `createPackageBody`; edit sends `updatePackageBody` — only the fields that differ from the package as read, `null` for a cleared price, and nothing at all ("nothing has changed") when the form is untouched. Feature keys compare as a set | a price sent that was not meant is a subscriber's period with nothing to charge (`package_price_in_use`) |
| 4 | **The wholesale rate is asked per GiB of `vpn.traffic`**, labelled by the meter's name (`useMeterNames`, F-118-s), and sent as `unitSize: "1073741824"` (`WHOLESALE_METERS`). A blank field over a rate in force sends `{meterKey, unitPrice: null}`, which switches the meter off; the hint says what that does — resellers on the package can no longer sell pay-as-you-go VPN on the platform's panels (F-118-n2) | the service stores bytes; the owner thinks in GiB, as the catalog's rate card does (F-118-m) |
| 4b | **An unlimited plan's flat price is asked per 30 days of `vpn.unlimited.time`** (F-118-aa, D-59 (c)) and sent as `unitSize: "2592000"` (`WHOLESALE_PERIOD`); blank over a rate in force is `unitPrice: null` like rule 4. The hint says it is charged pro rata to the days sold (a 90-day plan three times, a 15-day renewal half), days left at an early close come back, and blank means resellers on the package cannot sell unlimited plans on the platform's panels (`wholesale_rate_missing`, entitlement `contract.package-wholesale.md`). Each field shows the rate error only when its own value is bad (`badRate`) | the service charges per `unitSize` seconds (F-118-z); an owner prices a month, not a second |
| 4c | **A new link's wholesale price is asked per use of `vpn.config.regenerate`** (F-118-r) and sent as `unitSize: "1"`; blank is rule 4's. Without it a reseller on the package cannot sell a variant whose new link is priced (`wholesale_rate_missing`) — the door buys every use wholesale, free ones included (F-118-h) | a reseller's priced new link is otherwise unsellable |
| 5 | A rate on another meter, or in another `unitSize`, is listed read-only under the field ("set through the API") by its meter's name, never the key and never re-read as per GiB; a blank field then leaves it alone (`otherRates`) | the form cannot say what such a rate means per GiB, so it must not clear or rewrite it |
| 6 | A changed rate is a new row from now (tenant invariant 23): a Grant already sold keeps the rate it locked (F-118-n2). The hint says so | the owner should not expect a price change to reach services already sold |
| 7 | A new package is priced in the platform's operating currency (`GET /tenants/:id/operating-currency`, read with the list); an edit labels its fields in the package's own `currencyCode`. **New package** is disabled until that read lands | the service writes the package in the platform's currency (F-116-h3); a label in another would mislead |
| 8 | **Withdraw / Offer again** is `PATCH {isActive}` and nothing else. **Apply to subscribers** asks once (`window.confirm`) — a removed feature is taken away now, not at renewal — then `POST /apply` and says how many subscribers it reached | `apply` is the one immediate removal (F-018-o); it should never be one click |
| 9 | Validation mirrors `tenant-package.schema.ts` before the call: a name of 1–80, a price positive with two places, at least one of the two, a rate positive with eight. The service's refusals (`TenantPackageRejection`) each have a sentence in `resellers.refusals`, held by `resellers.test.ts` with the other services' | a refusal caught on the page costs no round trip; one that is not still reads as a sentence |
| 10 | The feature list is `PACKAGE_FEATURE_KEYS`, shared-core's `TENANT_FEATURE_KEYS` in its order, each named in `resellers.packages.features`; `packages.test.ts` holds the two together | a new sellable feature does not ship unnamed or unofferable |

Spec: `resellers/packages.test.ts`.
