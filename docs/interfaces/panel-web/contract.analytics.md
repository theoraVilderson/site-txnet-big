---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-06
---

# Contract — panel-web: `/analytics` and the chart kit (F-1001…F-1007)

The analytics page for the platform owner and every reseller, and the chart
kit it is built on. Decided by the user on 2026-10-06; written before any of it
is built — each rule names its backlog row. The figures and their definitions
are [billing/contract.analytics.md](../../domains/billing/contract.analytics.md);
this file never redefines one.

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
  accent** (user, 2026-10-06). The check, per theme: OKLCH lightness inside the
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
  survives a reload. Below `md` it is one Filters button opening a `Sheet`,
  showing how many filters are on.
- **Tabs** (`TabLinks`, `?tab=`): Overview, Sales, Customers, Products and
  panels, Resellers (owner), Profit (after F-1002), Cohorts, Capacity, Reports.
- **Live:** the page re-reads on `billing.analytics.refreshed` with
  `useLiveReread` (C-14) — never a poll.
- **Rebuilding** (zone change) shows an `Alert` instead of half-built numbers.

### Overview (F-1001-d)

1. **Hero card** (full width): net sales as a large `AnimatedNumber`, its
   `DeltaPill`, and a `TrendChart` area with the previous period behind it. A
   `SegmentedControl` switches the hero between net sales, top-ups, orders and
   new buyers — one chart, one axis.
2. **KPI row** of six `StatTile`s: orders, average order, buyers (new /
   returning under it), renewal rate (`Meter`), active services, traffic. A
   tile click moves the hero to that metric.
3. **Insights strip**: up to three sentences (F-1001-j), each with an icon and
   a link to the tab that explains it.
4. **Sales by product** (`BarList`) beside **new vs returning buyers**
   (`StackedColumns`).
5. **Calendar heatmap** of daily net sales for the last year — the
   "when do we sell" picture at a glance.
6. Owner only: the **top 5 resellers** with sparklines, linking to the tab.

### Other tabs

- **Sales** (F-1001-e): package vs usage sales (`StackedColumns`), sales vs
  top-ups as two charts, payment success rate by gateway (`BarList`),
  discounts and gifts, refunds by product.
- **Products and panels** (F-1001-e): one `DataTable` each, every row with its
  sparkline and share; a row click filters the whole page to it.
- **Customers** (F-1001-g): new vs returning, the signup → first-purchase
  funnel, renewal by product, top customers (a reseller's own only); the
  renewal window setting (1–30 days, default 7) sits here for `tenant.manage`.
- **Resellers** (F-1001-i): the tier-A leaderboard; a cell under 5 people
  reads "fewer than 5", never a figure.
- **Profit** (F-1001-m), **Cohorts** (F-1004-b), **Capacity** (F-1005-b),
  **Reports** (F-1006-b): each in its row, on the same kit and rules.

## Elsewhere (F-1001-k)

The dashboard's `revenue` widget (D5) gains a "see analytics" link and a
sparkline from the overview route; nothing else on the dashboard changes.
