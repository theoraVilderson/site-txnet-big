---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-06
---

# Contract — billing / analytics: the rollup every report reads (F-1001…F-1007)

The figures behind `/analytics` for the platform owner and for every reseller.
Decided by the user on 2026-10-06; written before any of it is built, so an
implementing session has nothing left to decide. **Built: the rollup and its
worker (F-1001-a); `overview`, `sales`, `catalog` and `analytics.read`
(F-1001-b); the export (F-1007-a); insights (F-1001-j); usage per meter and the product kind (F-1001-n); `customers` and the renewal window (F-1001-f); `resellers` (F-1001-h); cost attribution (F-1002-b); `margin` (F-1001-l).** Everything else is not yet — each rule names its row. Tabs built after F-1001-e are written up in [contract.analytics-tabs.md](contract.analytics-tabs.md). The page and its charts are
[panel-web/contract.analytics.md](../../interfaces/panel-web/contract.analytics.md).
A fact that turns out wrong is said in one line and the rule corrected.

## Principles (every row)

1. **One source per figure.** Every analytics number is read from the rollup
   tables below. No analytics route reads a ledger; only the rollup worker does.
   A report that needs a figure the rollup lacks adds a measure here first.
2. **A sale is what `IS_SALE` says.** The worker imports `SALE_REASONS` and
   `UNDOES` from `revenue/reseller-revenue.service.ts` — no second
   classification. For the same tenant and range, `/analytics` net sales equals
   `/revenue`'s `sales.total` to the cent; a spec proves it (F-1001-a).
3. **Sales and top-ups are never one number** (ADR-0067). Both are answered;
   neither is folded into the other, and no response field is named `revenue`.
4. **Scope is the path's tenant, through `ResellerAccess`.** A reseller reads
   only its own `tenant_billing` tree; no reseller figure ever comes from
   `platform_billing` (catalog rule, area 18). The platform owner's own
   analytics are the platform tenant's. Across resellers the owner gets tier A
   only (ADR-0104): whole-reseller totals, a breakdown cell under 5 people as
   `fewer_than_5`, no names, no drill to people — exports included.
5. **A day is the tenant's day.** `day` is the calendar date of the event in
   the tenant's resolved zone (TZ-1). Changing the zone rebuilds that tenant's
   whole rollup; until it finishes, reads say `rebuilding`.
6. **A sum never crosses currencies.** Every money row carries
   `currencyCode`. A range that spans a currency change (F-116) answers one
   series per currency, and the page says so; nothing is converted here —
   **except cost**, converted at its own day's rate when written (ADR-0149).
7. **Money is a decimal string** end to end (C-02); counts are ints.
8. **Permission `analytics.read`**, so a reseller can give a staff seat its
   numbers and nothing else (`ResellerAccess.for('analytics.read')`).
   **Corrected (ADR-0144, no Admin role):** a tenant key on `grantable:`,
   given to every holder of `report.read` by migration
   `20261015001500_analytics_read_key` (role, group or person, same source)
   and suggested by the finance and sales group presets.

## Rollup tables — schema `billing` (F-1001-a)

Two kinds, never mixed: **flows** (what happened during a day, summable over
days) and **stocks** (what stood at the end of a day, never summed over days).

| table | grain (key) | measures |
|---|---|---|
| `analytics_sales_day` (flow) | tenant · day · currency · product · variant · panel · kind (`package` = a sale naming an invoice, `product_purchase`; `usage` = one naming a Grant, `traffic_consumption` and `usage_charge` — `REFERS_TO`) | `gross`, `refunds`, `net`, `orders` (package purchases net of refunds), `bytesSold`, `discounts` (invoice discount taken) |
| `analytics_user_day` (flow) | tenant · day · currency · user · product · panel (F-1001-b: buyers per product and panel; a top-up row has neither) | `net`, `orders`, `topUps`, `firstPurchase` (bool) — sparse, only users with activity |
| `analytics_payment_day` (flow) | tenant · day · currency · gateway kind | `started`, `settled`, `failed`, `settledAmount`, `giftsCredited` (coupon/gift credits) |
| `analytics_stock_day` (stock) | tenant · day · product · panel | `activeGrants`, `frozenGrants`, `activeUsers`, `bytesUsed` |
| `analytics_grant_end` (F-1001-f) | grant · `endedOn` (*corrected*: a term, `contract.analytics-tabs.md`) | tenant, user, product, panel, `renewedOn?`, `state` (`renewed` / `lapsed` / `pending`) |
| `analytics_signup_day` (flow, F-1001-f) | tenant · day · source | `signups`, `purchased7`, `purchased30` — from `analytics_signup`, written by identity's `identity.user.signed_up`, never a cross-schema read |
| `analytics_meter_day` (flow, F-1001-n, ADR-0148) | tenant · day · product · panel · meter | `quantity` (the meter's unit), `grants` — from `billing.usage_event`; `vpn.traffic` from `network.traffic_daily_aggregate` only |

**As built (F-1001-a, `billing-service/src/app/analytics/`).** A grain's null
product or panel is one cell (`NULLS NOT DISTINCT` unique). A sale's panel is
its Grant's first config's. `bytesSold` is a package's `quotas.traffic_bytes`
(net of a refunded one); a block's bytes are not on its ledger row, so usage
sells 0 bytes and its traffic is `bytesUsed`. `topUps`, `started/settled/failed`
count by the payment's `createdAt`, as `/revenue` does; `expired` is neither
settled nor failed; `giftsCredited` is `coupon_redemption` credits under a null
gateway kind. **A stock is a snapshot**: no ledger holds past freezes, so a
pass writes the Grants standing now on today only (`frozenGrants` = an
`admin_frozen` suspension), and a day keeps its last snapshot; a rebuild never
rewrites one. `bytesUsed` comes from `network.traffic_daily_aggregate` on its
UTC date, nightly, so a day's traffic lands a pass later.
`analytics_rollup_state` (one row per tenant): `timeZone` the days were cut in,
`version` (+1 on a changed pass), `refreshedAt`, `rebuildingSince`.

`buyers` over any range is `count(distinct user)` on `analytics_user_day`;
`newBuyers` counts `firstPurchase`. That is why the user grain exists: distinct
counts cannot be summed from daily totals.

**Renewal.** A Grant whose term ended in the range is `renewed` when its own
term was extended, or the same user started a Grant of the same product, within
`renewalWindowDays` before or after the end; `lapsed` once the window passed
without one; `pending` while it is open. Rate = renewed ÷ (renewed + lapsed);
`pending` is shown beside it, never in it. An admin renewal (F-311-d) counts as
a renewal and never as a sale. `renewalWindowDays` is a tenant setting, 1..30,
default 7 (user, 2026-10-06; F-1001-f).

## The worker (F-1001-a)

- `rollup(tenantId, fromDay, toDay)` replaces every row of that tenant and
  range in one transaction, under a per-tenant `pg_advisory_xact_lock` —
  idempotent; running it twice changes nothing.
- Today and yesterday every 5 minutes (`analytics_rollup` job, `*/5`), up to
  200 tenants a tick, never-rolled then stalest first — so yesterday is closed
  by every pass until it leaves the window. A tenant whose `tenant.timezone`
  differs from its state's `timeZone`, or whose rebuild died mid-way, is
  rebuilt whole by the tick: from its first ledger or payment row to today.
- `POST /api/internal/billing/analytics/refresh` (the tick; answers `tenants`,
  `changed`, `rebuilt`) and `…/rebuild` `{tenantId}` (a fixed bug; answers
  `changed`), `ServiceOnlyGuard`.
- A pass that changed a row writes `billing.analytics.refreshed`
  `{tenantId, from, to}` in the same transaction, on `tenant:` (ADR-0121, C-14;
  a row in `realtime/contract.live-events.md`); for a reseller with an owner,
  also `billing.analytics.reseller_refreshed` to the owner's `user:` and the
  platform's `tenant:` (F-1001-p). Every read answers
  `refreshedAt`.
- Read answers are cached in Redis by tenant + query + rollup version (built
  with `RedisKeys`, C-03; F-1001-b); a changed pass bumps the version.

## Read routes — one request per tab

All `GET /api/billing/tenants/:tenantId/analytics/<tab>` with
`from`, `to` (ISO dates, tenant days, ≤ 3 years), `compare` = `previous`
(default, same length just before) | `year` | `none`, filters `product`,
`panel`, `kind`, and `calendar` = `jalali` | `gregorian` (from the language).

- **Granularity is chosen by the server**: ≤ 62 days → day, ≤ 26 weeks → week
  (Saturday-start in `jalali`, Monday otherwise), else month (a Jalali month in
  `jalali`). The answer names it; `previousSeries` is aligned by index.
- **Every KPI** is `{value, previous, delta}`; `delta` is a ratio, or `new`
  when `previous` is 0 — never infinity, never a division by zero.
- **Every product, not only VPN (ADR-0148, F-1001-n).** Common figures for
  every kind; usage per meter — `overview` answers `usage` (per meter: total,
  previous, delta, series) and `names` gains `meters` (`key`, `unit`, `nameKey`)
  and `kinds` (the `fulfilmentKind`s in the window). Filter `fulfilment`, joined
  from `catalog.product` (fixed at creation). `bytesUsed` stays until its
  readers move, then goes (C-39).
  **As built (F-1001-n, `analytics-usage.ts`).** *Corrected:* the meter grain
  carries the panel too (a VPN Grant's first config's, else null), or a panel
  filter would leave usage unfiltered. A usage event lands on its `occurredAt`
  tenant day; `vpn.traffic` on the aggregate's UTC date, as `bytesUsed`, never
  also from its events. `grants` sums day rows — activity, not distinct
  services. A usage card is `{meterKey, total, previous, delta, series}`,
  quantities as integer strings, one per meter used in either window (key
  order); a bucket the series hide from the platform's staff is null.
  `fulfilment` narrows every product-bearing read, never payments; `kinds` is
  the window's products' kinds, `meters` read from `catalog.meter` by the
  tenant's own keys. The migration flagged every tenant for a whole rebuild.

| tab | row | answers |
|---|---|---|
| `overview` | F-1001-b | KPIs: `net`, `gross`, `refunds`, `topUps`, `orders`, `aov` (net ÷ orders), `buyers`, `newBuyers`, `returningBuyers`, `arpu`, `renewal` `{rate, renewed, lapsed, pending}`, `activeGrants` (end of range), `bytesUsed`; `series` (`salesPackage`, `salesUsage`, `topUps`, `orders`, `newBuyers` per bucket); `byProduct` top 7 + `other`; `calendar` (net per day, last 365 days) |
| `sales` | F-1001-b | series by kind; payments `started / settled / failed` and success rate by gateway kind; `discounts` and `giftsCredited`; refunds by product |
| `catalog` | F-1001-b | per product and per panel: net, orders, buyers, bytes, share, and a 12-point sparkline |
| `customers` | F-1001-f | new vs returning per bucket, signups → first purchase (within 7 and 30 days), renewal by product, top 20 customers by net — **a reseller's own users only**; the owner's view of a reseller never lists people |
| `resellers` | F-1001-h | platform owner only: each reseller's net, top-ups, buyers, active Grants, delta, sparkline — tier A |
| `margin` | F-1001-l | revenue − attributed cost per user, product, panel (and reseller for the owner); loss-making rows flagged |
| `cohorts` | F-1004-a | first-purchase month × month k: share still buying, net per user, cumulative LTV; split by acquisition channel |

**As built (F-1001-b, `analytics/analytics.service.ts`).** Money is a map per
currency, `{"USD": "41.25"}`; `currencies` lists them, the operating currency
first, and a share is of that one. Every answer carries `tab`, `query` (as
resolved; `calendar` defaults to `gregorian`), `refreshedAt` (read fresh, never
cached) and `rebuilding`; while true there are no figures. A buyer is a user
with a sale or refund in the cell (`net` or `orders` ≠ 0); `topUps` is
`analytics_payment_day.settledAmount`, so product and panel filters leave it
whole. `renewal` is F-1001-f's (`contract.analytics-tabs.md`). Buckets are named by their first day
inside the window. To the platform's staff on a reseller (`suppressed`): series
buckets, calendar days and product/panel rows under 5 buyers, with their
complements (`hiddenCells`), and `payments.byKind` is `null` — the rollup has
no payer per gateway. Cache: `analytics:<tenant>:v<version>:<tab>:<hash>`, 1 h,
bucket `ANALYTICS_READ`. **F-1001-d added (C-37, additive):** every tab answers
`names` — each product (`nameKey`, catalog order) and panel (`name`) with a
sales or stock row in the window, unfiltered, so a filter that is on stays a
choice (`analytics-names.ts`); and `series.returningBuyers` (buyers − new, per
bucket) for the overview's new vs returning.

**Insights** (F-1001-j): `overview` also answers up to three `insights`, each
`{key, params}` rendered from locale keys — no language model. In order: the
KPI with the largest absolute delta; the product that contributed most to the
change in `net`; a day more than 2σ off its 28-day mean. A rule with nothing
to say says nothing.

**As built (F-1001-j, `analytics-insights.ts`).** `key` names the sentence —
`kpiMove {kpi, delta, currency}`, `productDrove {productId, change, currency}`,
`unusualDay {day, net, mean, currency}` — and the panel's locale holds its
words. Money is the operating currency's. A `new` delta never competes; the
product named moved net the way net moved; a day is judged against its own
previous 28 days, and a flat baseline (σ 0) judges nothing. Nothing compared,
no product rule; a product filter on, no product rule; to the platform's staff
on a reseller a hidden product is never named and the day rule is off (a day
and its mean could describe a hidden cell). The export leaves `insights` out.

## Export (F-1007-a)

Every tab route answers `format=csv` or `format=xlsx` through one exporter:
same filters, same scope, same tier-A suppression. `xlsx` has one sheet per
block (Summary, Series, By product, …), numbers as numbers with the currency's
decimals, dates in the tenant zone, and in `jalali` a Jalali date column beside
the Gregorian one. File name `analytics-<tab>-<from>-<to>.<ext>`. A later report
gets export by being a tab — it adds nothing to the exporter.

**As built (F-1007-a).** `format` on the same routes; the answer is read
through `AnalyticsService.read` (door, cache, suppression), then flattened **by
shape** (`analytics-export.ts`): a KPI, an amount or a lone figure is a Summary
row per currency; an object of bucket-long arrays a by-bucket block; an array
of rows a block, a column per field and currency, `fewer_than_5` as words. A
new field needs a `billing.analyticsExport.labels` key, else it reads as its
name. Products by the reader's `catalog` text, panels by name; the currency's
`decimalPlaces`; RTL sheets when `Intl` says the language is. CSV: a titled
section per block, BOM, formula-leading text quoted. A rebuild answers 409
`rebuilding`. The shared `ResponseInterceptor` lets a `StreamableFile` through.

## Cost and margin (F-1002-b, F-1001-l, F-1003)

- **The platform's cost is a panel's monthly cost** (network, F-1002-a: USD,
  `effectiveFrom`, a change adds a row). A day's cost is the month's amount ÷
  the month's days, split over Grants by the bytes each used on that panel
  that day. A day with no traffic keeps its cost on the panel as **idle** —
  shown, never spread or hidden. A panel with no cost set attributes 0 and the
  margin says `no cost set`.
- **A reseller's cost is what it pays the platform**: `metered_usage_charge`
  split by bytes per product; `subscription_charge` spread over its period's
  days as an unallocated fixed cost.
- `analytics_cost_day`: tenant · day · panel · product · user? — `cost`, `bytes` (*as built*: also kind, served tenant, currency, and the cost in the sale's currency — `contract.analytics-tabs.md`).
- Margin = net − cost, and margin % = margin ÷ net (none when net is 0).
- **F-1003**: a user whose 30-day cost exceeds their 30-day net, by more than
  the tenant's threshold, is reported once per month to the tenant's staff
  (bot + panel inbox), as F-1528-b is.

## Cohorts (F-1004-a)

A cohort is a first-purchase month. **Open, asked at the start of F-1004-a:**
no doc names where a user's acquisition channel is recorded (referral, deep
link, campaign, organic). Cohorts without a channel split can ship first.
