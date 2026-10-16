---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-16
---

# Contract — panel-web: `/analytics` and the chart kit (F-1001…F-1007)

The analytics page for the platform owner and every reseller, and the chart
kit it is built on. Decided by the user on 2026-10-06; written before any of it
is built — each rule names its backlog row. The figures and their definitions
are [billing/contract.analytics.md](../../domains/billing/contract.analytics.md);
this file never redefines one. **Built: the chart kit (F-1001-c); the page,
its filter bar and the Overview (F-1001-d); the insights strip and the
dashboard's sparkline (F-1001-k); the Overview by meter (F-1001-o); Sales and Products and panels (F-1001-e); Customers (F-1001-g); Resellers and the top five (F-1001-i); Profit (F-1001-m); Cohorts and `CohortGrid` (F-1004-b); Capacity (F-1005-b); Reports (F-1006-b) — tabs after Resellers in [contract.analytics-tabs.md](contract.analytics-tabs.md).** The other tabs are not yet.

**The aim, in the user's words: professional, simple, a pleasure to use, and
showing a lot.** "Simple" here means one question per card, one axis per chart,
and every number one tap away from its exact value — not fewer numbers.

## Chart kit — `(panel)/_components/kit/charts/` (F-1001-c)

Built on **visx** (user, 2026-10-06): `@visx/scale`, `shape`, `axis`, `group`,
`grid`, `responsive`, `curve`, `event` — scoped imports, versions pinned exact,
loaded only by the routes that draw charts. No second chart library, ever; a
page that needs a chart uses the kit.

| piece | job |
|---|---|
| `StatTile` | value + delta + sparkline; `size` 1 or 2 (the hero) |
| `DeltaPill` | ▲/▼ icon + percent + "vs previous"; `new` when previous was 0 |
| `TrendChart` | line or area over time, one series + the previous period, or ≤ 4 series |
| `BarList` | horizontal bars, sorted, top 7 + Other, value and share as labels |
| `StackedColumns` | parts of a whole per bucket, ≤ 4 series |
| `CalendarHeatmap` | one cell per day, sequential single hue, weeks as columns |
| `Meter` | one ratio against its whole (renewal rate) |
| `CohortGrid` | a heatmap table, sequential |
| `ChartCard` | title, subtitle, legend, a table-view toggle, its own skeleton / empty / error |
| `chartPalette`, `useChartTheme` | the colours below, per theme, with the brand check |

**As built (F-1001-c).** Pages import `kit/charts` (its own index, so only a
chart route loads visx). The slots are tokens, `--chart-1`…`--chart-8` per
theme in `globals.css`, beside `--chart-surface`, `--chart-accent` (the
theme's accent, which a brand never overrides), `--chart-other`, `--chart-muted`
and `--chart-grid`; `palette.ts` names them (`slotColor`, `slotsByEntity`), and
`charts.test.tsx` holds them to the table below. `useChartTheme` reads the
computed surface off `<html>`. Formats come from the page (`formatValue`, x
labels in its calendar), the compact default from `numberLocale`. Ticks are
chosen, never d3's hint (which can give 8). `CohortGrid` was built with its
first user (F-1004-b; `contract.analytics-tabs.md` "Cohorts"). The dark accent (`#4ade80`, L 0.80) and ocean's (chroma 0.098) fail the
check themselves — see the main series rule below.

### Rules every chart obeys

1. **One y-axis.** Two measures on different scales are two charts, never a
   dual axis. The hero switches metric; it does not stack two scales.
2. **The previous period is always muted**: the same shape, dashed (4 3),
   `muted ink`, drawn under the current series; the tooltip shows both values
   and the delta.
3. **Colour follows the entity, never its rank.** A product keeps its slot in
   every chart and every filter: slots are given in the catalog's own order,
   and Other is always neutral grey. A filter that removes a series never
   repaints the rest.
4. **Status colours are reserved** for good / bad deltas and alerts, always
   with an icon and a word, never colour alone. No series ever uses them, and
   gold is never a series (panel theme rule).
5. **≥ 2 series → a legend; ≤ 4 → also direct labels** at the line ends or
   bar tips. Never a number on every point.
6. **Every chart has a table view** (a toggle in `ChartCard`, `DataTable`
   underneath, K13). It is the accessible reading, the exact numbers, and the
   relief for the light theme's three slots under 3:1.
7. **Marks:** 2px lines, 4px rounded bar ends, a 2px gap between bars and
   stacked segments, horizontal hairline grid only, ≤ 5 nice y-ticks, a bar or
   area axis starts at 0.
8. **Time runs left to right in every language** (user, 2026-10-06): the plot
   is `dir="ltr"`; titles, labels, legends and tooltips stay in the page's
   direction. Digits come from `numberLocale`, dates from the Jalali or
   Gregorian calendar of the language, money from `formatMoney`; axes use a
   compact form (`۱٫۲ میلیون`), the tooltip the full value.
9. **Hover and touch:** a crosshair and one tooltip on line/area, a tooltip per
   bar or cell; hit targets ≥ 24px; a tap pins the tooltip on touch; the chart
   is focusable and the arrow keys walk its points, the tooltip following.
10. **Motion** (M1–M3): a line draws and an area rises in 600ms on first paint;
    new data morphs in `slow` (320ms); hero numbers count up (`AnimatedNumber`).
    `reduced` motion: none of it.
11. **Loading:** first load shows a skeleton shaped like the chart. A filter
    change keeps the old chart at 50% opacity under the route progress bar —
    never a skeleton flash. Each card fails alone, with its own retry.
12. **Phone first** (the Mini App is a phone): every chart works at 360px wide
    with no horizontal scroll; the calendar heatmap shows the last 13 weeks
    below `md`.

### Colour (validated 2026-10-06 against each theme's card surface)

Categorical slots, in this order — the order is what keeps neighbours apart
for colour-blind readers:

| slot | light | dark and ocean |
|---|---|---|
| 1 blue | `#2a78d6` | `#3987e5` |
| 2 orange | `#eb6834` | `#d95926` |
| 3 aqua | `#1baf7a` | `#199e70` |
| 4 yellow | `#eda100` | `#c98500` |
| 5 magenta | `#e87ba4` | `#d55181` |
| 6 green | `#008300` | `#008300` |
| 7 violet | `#4a3aa7` | `#9085e9` |
| 8 red | `#e34948` | `#e66767` |

Light passes every gate except contrast for slots 3–5 (relief: rule 6); dark
(`#112218`) and ocean (`#0b2a3b`) pass all. A ninth series is never a new
hue: it folds into Other. A palette change re-runs the validator and updates
this table.

- **The main series** (sales in the hero, any one-series chart, the heatmap's
  hue) is **the tenant's brand accent if it passes the check, else the theme's
  accent** (user, 2026-10-06) **if that passes, else slot 1** (user,
  2026-10-15: a fallback never fails the check; dark and ocean draw blue
  without a brand). `mainSeriesOf` in `charts/color.ts`. The check, per theme: OKLCH lightness inside the
  band (light 0.43–0.77, dark 0.48–0.67), chroma ≥ 0.1, contrast ≥ 3:1 on the
  card surface. `useChartTheme` runs it once per theme and brand; a spec holds
  a pale and a red brand failing it.
- **Sequential** (heatmap, cohort grid): the main series' hue in 5 steps from
  the surface to full, lightness strictly monotonic.

## The page — `/analytics` (F-1001-d)

A menu entry under the business section, behind `analytics.read`. The same
page for the owner and a reseller; the owner also gets the Resellers tab.

- **Header** (`PageHeader`): title, "updated N min ago" from `refreshedAt`, an
  Export menu (CSV, Excel) for the current tab.
- **Filter bar**, one row, sticky under the top bar: range presets (today,
  7 days, 30 days, this month, last month, 90 days, custom with `DatePicker`);
  compare (previous period / same period last year / none); product; panel;
  reseller (owner). Everything lives in the URL, so a view can be shared and
  survives a reload. Below `md` the bar is the button opening a `Sheet`: what
  is on in one line under "Filters", how many as a badge.
- **Tabs** (`TabLinks`, `?tab=`): Overview, Sales, Customers, Products and
  panels, Resellers (owner), Profit (after F-1002), Cohorts, Capacity, Reports.
  Cohorts ("Retention") and Capacity are views under Customers and Products
  and panels (`TAB_VIEWS`, own `?tab=`). The row wraps from `md`; below it one
  `Select` (`AnalyticsTabs`). 3+ long labels are a `Select`, never a segment.
- **Live:** the page re-reads on `billing.analytics.refreshed` with
  `useLiveReread` (C-14) — never a poll.
- **Rebuilding** (zone change) shows an `Alert` instead of half-built numbers.

**As built (F-1001-d, `(panel)/analytics/`).** One `AnalyticsView`, three
addresses: `/analytics` reads the session's tenant; `/reseller/analytics` and
`/my-resellers/:id/analytics` hand it the reseller (workspace rule 4) — its
owner signs in to the platform's tenant, so it reads its own there, and the
menu row is the workspace's (`analytics.read`). The URL holds `tab`, `range`
(a preset, or `custom` with `from`/`to`), `compare`, `product`, `panel` and
`currency`, defaults left off (`_lib/filters.ts`). Presets are cut on the
viewer's day, months in the language's calendar (`Intl`: Jalali for Persian);
the figures are cut on the tenant's. **Live everywhere** (`_lib/live.ts`): the
session's tenant on its `tenant:` channel; a workspace view on its owner's
`user:` and the platform's `tenant:`, re-reading only for its own reseller
(F-1001-p, RT-1-e's pair). Names come from billing's `names` (product `nameKey`
-> the published `catalog` texts; a panel's own name). Several currencies: an
`Alert` with the currency picker, never one sum. Kit additions: `TabLinks` `current` (tabs that share
a path), `BarList` `other` (billing's folded remainder, never folded twice).
**Export (F-1007-b):** `ExportMenu` in the header saves the tab and filters on
screen through billing's `format=` (the same door and under-5 rule), saved by
`_lib/download.ts` (gift-code CSVs share it); a refusal is a toast in its words.

### Overview (F-1001-d)

1. **Hero card** (full width): net sales as a large `AnimatedNumber`, its
   `DeltaPill`, and a `TrendChart` area with the previous period behind it. A
   `Select` switches the hero between net sales, top-ups, orders and new
   buyers — one chart, one axis.
2. **KPI row** of six `StatTile`s: orders, average order, buyers (new /
   returning under it), renewal rate (`Meter`), active services, traffic. A
   tile click moves the hero to that metric.
3. **Insights strip**: up to three sentences (F-1001-j), each with an icon and
   a link to the tab that explains it.
4. **Sales by product** (`BarList`); new vs returning buyers is Customers'.
5. Owner only: the **top 5 resellers** with sparklines, linking to the tab.
6. Folded under **more details** (`<details>`, closed): the usage cards and the
   **calendar heatmap** of daily net sales for the last year.

**By meter, not by VPN (ADR-0148, F-1001-o).** The KPI row keeps the
common tiles; "traffic" becomes one tile per meter in the window (its
`nameKey`, written in its unit), and a usage card per meter joins the Overview.
The filter bar gains the product kind when the window holds more than one;
the panel filter and per-panel lists are drawn only when a product has a panel.
**As built (F-1001-o, `_lib/usage.ts`, `UsageCards`).** A tile and a card per
`usage` card billing answers, named by the meter's `nameKey` in the catalog
texts ("usage" without one) and written by `UNIT_FORMATS` — bytes as a size,
seconds as hours, tokens with their word; a unit without a format fails the
spec. No meter used: no tile, no card. The kind filter (`?fulfilment=`) is a
`Select` when `names.kinds` holds two, and stays while one is on; the panel
filter already draws only when `names.panels` has one.

### Other tabs

- **Sales** (F-1001-e): package vs usage sales (`StackedColumns`), sales vs
  top-ups as two charts, payment success rate by gateway (`BarList`),
  discounts and gifts, refunds by product.
- **Products and panels** (F-1001-e): one `DataTable` each, every row with its
  sparkline and share; a row click filters the whole page to it.
- **As built (F-1001-e, `SalesTab`, `CatalogTab`).** Sales adds a tile row
  (payment success with its `Meter`, discounts, gifts, refunds — down is good);
  a gateway is its provider's name as billing answers it, and to the platform's
  staff on a reseller the card says why it is empty. Products and panels: a
  row's name opens the Overview filtered to it; the panel table only with a
  panel, the traffic columns only when a row moved a byte (ADR-0148 (4)); a row
  under 5 buyers reads "fewer than 5" in every figure. An answer is drawn only
  by the tab it is for (`AnalyticsTabAnswer`): the last tab's stays off screen.
- **Customers** (F-1001-g): new vs returning, the signup → first-purchase
  funnel, renewal by product, top customers (a reseller's own only); the
  renewal window setting (1–30 days, default 7) sits here for `tenant.manage`.
  **As built (`CustomersTab`, `AnalyticsSettingField` — shared with Profit's percent since F-1003 — `_lib/customers.ts`).**
  Tiles: renewal rate (`Meter`, renewed · lapsed · still open under it), signups,
  bought within 7 and 30 days; signups per bucket and by source (a bot platform
  by its name); a top customer opens their user page. The window is always said;
  the form shows to billing's door (*corrected*: `settings.manage`, the split of
  `tenant.manage`; `platform.tenant.manage`; a reseller's owner on `/reseller`).
  The Overview's renewal tile reads billing's rate, a dash before any end.
- **Resellers** (F-1001-i): the tier-A leaderboard; a cell under 5 people
  reads "fewer than 5", never a figure. **As built (`ResellersTab`,
  `TopResellers`, `_lib/resellers.ts`).** Offered, and read, only on the
  platform's own view to `platform.report.read` (billing's door); anyone else
  asking lands on the Overview. A row: name (to its analytics), net with its
  `DeltaPill`, top-ups, buyers, services, sparkline (a hidden point is a gap).
  The Overview's top five read the tab beside it; both re-read on any
  reseller's `billing.analytics.reseller_refreshed` on the platform's channel.
- **Profit** (F-1001-m), **Cohorts** (F-1004-b), **Capacity** (F-1005-b),
  **Reports** (F-1006-b): each in its row, on the same kit and rules.

**Insights as built (F-1001-k, `_lib/insights.ts`, `OverviewInsights`).**
Under the KPI row; billing's `key` picks the sentence (`common.analytics.insights.*`,
up and down apart, so a figure is a size, never signed), a KPI by
`KPI_LABEL` — a key or KPI with no words here is left out, never shown raw.
The icon is neutral ink: a fall in refunds is good news. A product line links
to the page filtered to it, a day line to that day alone (the view's own
`hrefOf`); a KPI line has no link until the Sales tab (F-1001-e). None: no strip.

## Elsewhere (F-1001-k)

The dashboard's `revenue` widget (D5) gains a "see analytics" link and a
sparkline from the overview route; nothing else on the dashboard changes.
**As built:** both only with `analytics.read` (`holdsPermission`, the menu
entry's key); the sparkline is the last 30 tenant days' net, `compare=none`, in
the operating currency, the kit's `Sparkline`. A refusal, a rebuild or a failed
read is no sparkline — never a failed widget, which the totals still answer.
