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
   window up to 30, so `PUT …/analytics/settings` `{renewalWindowDays}` (1..30;
   beside or instead of F-1003's `lossAlertPercent`, a write naming neither refused)
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

## Cost attribution (F-1002-b)

`analytics_cost_day` (tenant · day · kind · panel · served tenant · product ·
user · currency — `cost` to six places, `bytes`, and `saleCost` in
`saleCurrencyCode`, rule 5), written by every pass
(`analytics-rollup-cost.ts`, the arithmetic pure in `analytics-cost.ts`). Read
by `margin` (below).

1. **The platform's rows: its panels' price.** A day of a platform panel is
   its monthly USD price (network `contract.panel-cost.md`, `costOn`) over the
   month's days, split over the Grants that used it that day by bytes
   (`kind panel`) — the shares rounded to six places, the remainder on the
   largest, so a day sums to its price exactly. A day with no bytes keeps the
   whole day on the panel (`kind idle`). A day before a panel's first price
   writes nothing: "no cost set" is read from `panel_cost`, never stored as 0.
2. **Every tenant's Grants, by tenant only.** A reseller's users ride the
   platform's panels, so the platform's pass reads their bytes through the
   cross-tenant pool; such a row names the reseller (`servedTenantId`) and no
   product or person (ADR-0104). The platform's own Grants name both.
3. **A reseller's rows: what it pays the platform.** `metered_usage_charge`
   net of `metered_usage_refund` per tenant day, `kind wholesale`: a charge
   naming a Grant (itself, or a usage token, quota adjustment, renewal or end
   move carrying its `grantId`) is that Grant's product, panel and user,
   whole (*corrected*, ADR-0151 (4)); the rest split by its Grants' bytes on
   the platform's panels (ADR-0149 (3); a day with no bytes is unallocated). Each `subscription_charge` is spread over the
   days until the next one — the last until `currentPeriodEnd` — unallocated
   (`kind subscription`): the periods as charged, whatever the billing model.
4. **Days.** Panel costs are cut on the UTC date, as the traffic that splits
   them is; a reseller's charges on its tenant day, split by the bytes of the
   same date. Cost is in USD on the platform's rows and in the billing wallet's
   currency on a reseller's — `cost` is never converted (principle 6); rule 5
   is its converted copy.
5. **In the sale's currency** (ADR-0149, `analytics-fx.ts`). Each row is also
   written in the currency the tenant sold in at the end of its day — the
   `fromCode` of its first later `currency_change`, else today's, so no pass
   after a change moves an earlier day's cost into the new money (F-1001-q) —
   at the rate in force at the end of its day — a live pin (the tenant's first), else the
   newest discovered rate, the toman as the rial over ten. No rate: `saleCost`
   null, and every read answers that cost in its own currency.
6. **Every tenant's own costs** (F-1002-e, ADR-0151, catalog
   [contract.cost.md](../catalog/contract.cost.md)): a purchase costs its
   variant's cost in effect when the invoice was made (`kind sale`; its
   refund the same back), a meter's use its quantity ÷ `unitSize` × `unitCost`
   in effect then (`kind usage`) — never `vpn.traffic`, never a meter with a
   wholesale leg (that charge is its cost). `analytics-rollup-own-cost.ts`.
7. **A cost for earlier days restates them.** A catalog cost or a panel price
   from a past day sets `analytics_rollup_state.costsFrom` (the day before it,
   UTC; the earliest ask wins); the next pass rewrites that tenant's cost rows
   from it, bumps the version, and clears it unless a newer ask came in.

## Margin (F-1001-l)

`GET …/analytics/margin` (`analytics-margin.ts`, the arithmetic pure in
`analytics-margin-cells.ts`). Net is the sales grain's (the user grain's per
user); cost is `saleCost`, else `cost` in its own currency. It answers:

| field | what |
|---|---|
| `totals` | `net`, `cost`, `margin` as money KPIs with their deltas; `marginRate` and `previousMarginRate` (margin ÷ net in the operating currency, null with no net) |
| `costParts` | `attributed` (split by use), `idle` (a panel's day with no traffic), `unallocated` (paid for nothing a row shows: a subscription, a day with no bytes) |
| `series` | `net`, `cost`, `margin` per bucket |
| `products`, `panels` | a cell each — `{id, net, cost, margin, marginRate, loss, noCost}` — largest net first, then the deepest loss; `noCost`: it sold and no cost row names it (F-1002-f, ADR-0151 (5)), a cost of 0 being a cost |
| `users` | the 20 deepest losses, each with its `name` (F-1001-m; a label, as `topCustomers`'); `null` to the platform's staff on a reseller |
| `resellers` | the platform's own only: each reseller's payments to it (`net`) against its users' share of the platform's panels (`cost`), with `name` |
| `noCostPanels` | the platform's own only: its panels with a sale or a service in the window and no monthly cost on or before its end |
| `noCostProducts` | every tenant: the ids of `products` cells with `noCost` — its margin is not a margin until a cost is set (F-1002-f) |
| `lossAlertPercent` | the tenant's threshold for the loss alert (F-1003, below), for the form beside the users |

1. **A tenant's margin is its own.** Totals and lists count the cost of its
   own Grants and idle panels; on the platform, serving a reseller's users is
   `resellers`, never in the totals — its revenue is the reseller's payment,
   which no sale row holds.
2. **`loss`** is a margin below zero in the operating currency. A row with
   sales and no cost has rate 1; one with cost and no sales has no rate and is
   a loss.
3. **Filters.** Product, panel and kind of product narrow net and cost alike;
   `kind` (package / usage) narrows neither — a cost has no sale kind.
4. **Tier A.** To the platform's staff on a reseller, a product or panel under
   5 buyers reads `fewer_than_5` with its complement, and no user is listed.
   `resellers` are whole-reseller totals (ADR-0104 (2)); on the platform's own
   tenant the tab reads across tenants and is cached by the summed version, as
   `resellers` is.

## Loss alert (F-1003)

"This user costs more than they pay" (`analytics-loss.ts`, run by
`analytics-loss.service.ts`): `POST /api/internal/billing/analytics/loss-alerts`
(`ServiceOnlyGuard`; answers `tenants`, `told`, `failed`), called daily by
worker-service's `analytics_loss_alert`.

1. **The rule** (ADR-0149 (4)): over the last 30 tenant days, a user's own
   cost (`saleCost`, the operating currency only — an unconverted cost is
   never weighed) passed their net by more than the tenant's
   `lossAlertPercent` (0..500, default 20; `analytics_setting`). Exactly at it
   is not past it; a user who paid nothing and cost something always is.
2. **Once a tenant month.** A claim (`analytics_loss_alert`, tenant · user ·
   the month's first day, with the figures told) is inserted first; only a new
   claim tells anyone, so a second run, a redelivered tick or a later day of
   the same month is silent.
3. **The staff** are every active holder of `analytics.read` in the tenant and
   its owner: one `billing.analytics.user_loss` each — `{tenantId, userId (the
   one told), lossUserId, name, net, cost, currencyCode, percent}`, money as
   decimal strings — on the bot and in the panel inbox, `analyticsUserLoss`
   (auth-api). `name` is the user's name or username, else `#` and their id's
   first 8 characters.
4. **Each tenant alone.** Every tenant with a finished rollup, in its own scope
   and transaction; one failing is logged and counted in `failed`, never
   stopping the rest.
5. **The percent is a figure readers see** (`margin` answers it): a write that
   changes it bumps the rollup version and writes `billing.analytics.refreshed`,
   as a changed renewal window does.

## Cohorts (F-1004-a)

`GET …/analytics/cohorts` (`analytics-cohorts.ts`, the arithmetic pure in
`analytics-cohort-grid.ts`). It answers `months` (the window's months in the
reader's calendar — a Jalali month in `jalali`, the first named by the window's
first day) and four flat lists, so the export writes each as a block:

| field | what |
|---|---|
| `cohorts` | each month with a first purchase in it: `{cohort, users}` |
| `cells` | `{cohort, k, share, netPerUser, ltv}` for every month k a cohort has lived, up to the window's end |
| `channels` | each signup source: `{source, users}`, most people first |
| `channelLtv` | `{source, k, ltv}`: the source's LTV at month k |

1. **A cohort is people.** A member is a user whose first purchase ever
   (`analytics_user_day.firstPurchase`) fell in the window; their cohort is
   its month. Product, panel and kind filters do not narrow it.
2. **Over the cohort's size.** `share` is the members with a sale or refund in
   month k ÷ the cohort (counted apart from money, so a member paying in two
   currencies is one person); `netPerUser` their net that month ÷ the cohort;
   `ltv` the running sum of `netPerUser`. Money per currency (principle 6).
3. **A channel's curve pools only cohorts old enough**: month k sums the
   cohorts that have lived k months, over their members — a young cohort
   never drags a late month down. A point pooled from fewer than 3 of the
   channel's cohorts, and not all of them, is left out: a tail of one or two
   old cohorts falls below its neighbour (user, 2026-10-17).
4. **The channel** is `analytics_signup.source` (ADR-0149 (5)); a member with
   no signup row reads `unknown`.
5. **Tier A.** To the platform's staff on a reseller, a cohort or a channel
   under 5 people is `fewer_than_5` with its complement (`hiddenKeys`), and
   its cells and curve are left out.
