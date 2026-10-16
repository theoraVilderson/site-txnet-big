---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-16
---

# Contract — billing / analytics: the tabs as built after F-1001-e

A topic file of [contract.analytics.md](contract.analytics.md), opened because
that file was near its cap. The principles, the rollup, the worker and the read
routes are there and hold here unchanged; this file says what each later tab
answers and the decisions made building it. Code:
`billing-service/src/app/analytics/`.

## Customers (F-1001-f)

`GET …/analytics/customers` — the same query, door, cache and export as every
tab (`analytics-customers.ts`). It answers:

| field | what |
|---|---|
| `renewalWindowDays` | the window renewal was judged by — the tenant's, else 7 |
| `renewal` | `{rate, renewed, lapsed, pending}` over terms that **ended** in the window; also the Overview's `renewal` KPI |
| `renewalByProduct` | the same per product, most people first |
| `buyers` | `newBuyers`, `returningBuyers` per bucket |
| `signups` | `total`, `purchased7` and `purchased30` (`{count, rate}`: first purchase ever within 7 / 30 days of signing up), `series` per bucket, `bySource` |
| `topCustomers` | the 20 largest by net in the operating currency, each `{userId, name, net, orders}` — `null` to the platform's staff |

Rules, each a decision:

1. **A term is a Grant's end, not a Grant** (corrects the table's grain):
   `analytics_grant_end` is keyed by grant · `endedOn`, because a Grant an
   admin renewed in place ends more than once. A term ends when the Grant's
   `endsAt` passes (a cancelled Grant ends nothing), or when an admin moves it
   later — a `grant_renewal` (F-311-d) or a `grant_duration_change` (F-311-i)
   with a later end: that term is renewed on the day it was moved, or on its
   end when it was moved before (renewing early is renewing).
2. **A new Grant renews the term it is nearest.** Same user, same product,
   started after the ended Grant did, not cancelled; the start nearest the end
   within 30 days either side is `renewedOn`. Renewed when
   `|renewedOn − endedOn| ≤ window`; lapsed once today is past the end plus
   the window; pending until then. `panelId` is the Grant's first config's, so
   the panel filter narrows renewal as it does sales.
3. **The window re-states, never rebuilds.** `renewedOn` is kept for every
   window up to 30, so `PUT …/analytics/settings` `{renewalWindowDays}` (1..30)
   re-states every term in one `UPDATE` under the rollup's lock, bumps the
   version and writes `billing.analytics.refreshed` when a state moved. Its
   door is `settings.manage` (the split of `tenant.manage`, ADR-0144) or
   `platform.tenant.manage` — not `analytics.read`: it changes every reader's
   figures. Stored in `analytics_setting`, changed in place, not audited.
4. **A pass looks back 31 days** for both tables: a term up to 30 days old can
   still renew, a signup up to 30 days old can still buy. Older rows can no
   longer change, and a rebuild starts at the first signup or Grant too.
5. **Signups come by identity's event** (`identity.user.signed_up`, identity
   `contract.md` "Emits"), recorded by billing's metering-service as one
   `analytics_signup` row per user (a redelivery writes nothing). The users
   who existed before it were copied once by the migration, source `unknown`.
   A signup names no product: product and panel filters leave signups whole.
6. **Tier A** (ADR-0104 (3)): to the platform's staff on a reseller no person
   is listed, and a signup bucket or source, a buyers bucket or a product's
   renewal under 5 people is hidden with its complement — the whole tenant's
   count is answered, so the cells are judged as one whole. The tenant totals
   stay. A name is a label read from identity's `user`, as the lottery report
   reads one; never a figure.

## Resellers (F-1001-h)

`GET …/analytics/resellers` on the **platform's** tenant (`analytics-resellers.ts`)
— the door is the figures door, so the platform's staff with
`platform.report.read`; on a reseller's tenant it is refused `not_allowed`, even
to its owner, never answered empty. It answers `total` (every live reseller)
and `resellers`, the 100 largest by net in the platform's operating currency,
each `{resellerId, name, net, topUps, buyers, activeGrants, sparkline}`; one
with no sale in either window is counted in `total`, not listed.

1. **Whole-reseller totals are tier A** (ADR-0104 (2)): net as a money KPI
   with its delta, top-ups, distinct buyers and the services standing at its
   own last snapshot are shown whatever their size, as `overview` shows them
   to staff. `name` is its brand name, else its slug — a business, not a person.
2. **A sparkline point is a cell**: 12 points of whole days, net per
   currency; a point under 5 buyers is `null` with its complement
   (`hiddenKeys`), judged within that reseller — its net total is answered.
   A point with no sale is a zero, not a cell.
3. **Read across tenants**, through the cross-tenant pool, narrowed to live
   resellers so the platform's own rollup is never summed in. Product, panel
   and kind filters do not apply: a reseller's catalog is its own.
4. **Cached by the sum of every rollup version**, so any reseller's changed
   pass retires the answer; the page already re-reads on
   `billing.analytics.reseller_refreshed` (F-1001-p).
