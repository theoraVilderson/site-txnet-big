---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-16
---

# Contract — panel-web: `/analytics` tabs built after Resellers

A topic file of [contract.analytics.md](contract.analytics.md), opened because
that file was at its cap. The chart kit, its rules and the page hold here
unchanged; this file says what each later tab draws. The figures are
billing's ([contract.analytics-tabs.md](../../domains/billing/contract.analytics-tabs.md));
nothing here redefines one. Code: `(panel)/analytics/`.

## Profit (F-1001-m)

`ProfitTab`, over billing's `margin` (F-1001-l, ADR-0149), the tab `?tab=margin`
named "Profit", offered to every reader of `/analytics` (billing's door is
`analytics.read`, as every tab's).

1. **Tiles:** net, cost (down is good), margin, each with its `DeltaPill`;
   margin rate as a percent, a dash with no net.
2. **No cost set** (the platform's own view): an `Alert` names each panel in
   use with no monthly cost (`formatList`, the reader's conjunction) and links
   to `/systems`, where a panel's cost is set — a margin with no cost is not
   believed.
   **A product with no cost** (every view, F-1002-h, ADR-0151): its row's cost
   is a warning `Badge` "no cost set" and its rate a dash, and an `Alert` names
   each of billing's `noCostProducts` with a link to the catalog that costs it
   (`/catalog`, or the reseller's `…/catalog`). An answer without the field —
   cached before it existed — draws as one with none.
3. **Charts:** sales and cost as two series on one money axis (`TrendChart`,
   slots 1 and 2, legend); where the cost went (`BarList`: split by use, idle
   panels, unallocated). Each with its table view.
4. **Lists:** margin per product, per panel (only with a panel), the losing
   users (each by name, opening their user page — a workspace's own, as the
   Customers tab links) and, on the platform's own view, per reseller. A loss
   is a `Badge` with an icon and the word "Loss" beside the figure (rule 4); a
   row under 5 buyers reads "fewer than 5"; no user list where billing answers
   none.
5. **Live:** the platform's own view re-reads on any reseller's
   `billing.analytics.reseller_refreshed` too, as the Resellers tab does — its
   per-reseller block moves with every reseller's pass (`READS_EVERY_RESELLER`).
6. **The loss alert's percent** (F-1003): beside the losing users, the
   settings key's holders (`settingsEditable`, the renewal window's door) set
   the percent past which a user is reported, 0–500, in `AnalyticsSettingField`
   — the one form both settings use; billing answers the current one as
   `lossAlertPercent`, and a change re-reads the tab.

## Cohorts (F-1004-b)

`CohortsTab`, over billing's `cohorts` (F-1004-a), `?tab=cohorts`, offered to
every reader of `/analytics` — a view under Customers, named "Retention"
(`TAB_VIEWS`, `contract.analytics.md` "Tabs").

1. **The grid** (`CohortGrid`, the kit's): a row per cohort — its month in the
   reader's calendar (`formatMonth`: Jalali in Persian) and its size — and a
   column per month since. One metric at a time (`SegmentedControl`): still
   buying (share, the scale's top at 100%), net per member, lifetime value —
   money in the page's currency. Billing's flat cells are pivoted by
   `_lib/cohorts.ts`.
2. **`CohortGrid`** is a real `<table>`: every cell writes its value, the
   sequential hue (`theme.sequential`, five steps by share of the largest)
   only helps the eye; a month not lived is an empty cell, never a zero; a
   cohort hidden from the platform's staff is one cell, "fewer than 5". Light
   words on the two darkest steps in the light theme, and on every step in
   the dark. Wider than a phone, it scrolls inside its card.
3. **LTV by channel:** a `TrendChart` over month k for the four largest
   channels (rule 5; every channel in the table view), each drawn only as far
   as billing answered it. A channel is a signup source, named as the
   Customers tab names it (`_lib/sources.ts`).
4. Its table views are the flat lists: cohort · month · value, channel ·
   month · LTV.
5. **Opens on the last 12 months** while no range is in the URL
   (`defaultRangeOf`): 30 days holds one cohort and no month k, and read as
   an empty tab (user, 2026-10-17). A range the reader chose is kept across
   tabs; one that was only the last tab's default is not (`retabbed`).

## Capacity (F-1005-b)

`CapacityTab`, over billing's `capacity` (F-1005-a,
[contract.analytics-capacity.md](../../domains/billing/contract.analytics-capacity.md),
ADR-0150), `?tab=capacity`, offered to every reader of `/analytics` — a view
under Products and panels (`TAB_VIEWS`).

1. **This month, today:** the tab says its figures are the UTC month as of
   today, and that the range and comparison do not apply — the filter bar
   stays, so the other tabs keep their window.
2. **A card per panel**, soonest full first (billing's order): its full date
   as a `Badge` with an icon and words — full now, within 7 days
   (`SOON_DAYS`, warning), later, or not this month; traffic as a `Meter` of
   projected over allowance with used / projected / allowance in words; users
   as a `Meter` of users over the cap; the month's cost and projected margin,
   a loss with Profit's badge. Bytes are written by `formatBytes`.
3. **No price:** an `Alert` names the panels with none — no allowance to
   fill and no margin, each card saying "no cost set". The link to
   `/systems` only on the platform's own view (`resellersVisible`): a
   reseller cannot price a panel yet.
4. Its table view is every figure of every panel.

## Reports (F-1006-b)

`ReportsTab` and `ReportScheduleForm`, over billing's report schedules
([contract.analytics-reports.md](../../domains/billing/contract.analytics-reports.md),
ADR-0150), `?tab=reports`, offered to every reader of `/analytics`. A page tab,
not a figure tab (`PAGE_TABS`, `isFigureTab`): it reads schedules and no
figure, and has no export.

1. **The form**: how often (`SegmentedControl`), the weekday of a weekly one
   and the hour (`Select`, written by `Intl` in the language), the tab the
   link opens (any but Resellers), and the channels. A channel the person
   cannot be reached on — `reach` from billing — is offered disabled with what
   to do; no channel says so before asking (`reportBodyOf`). The month of a
   monthly one is the reader's calendar's (`calendarOf`). At ten, the form says
   the limit instead of failing.
2. **The list**: when each goes, the tab it opens, its channels and a paused
   badge, next and last send. The owner sees everyone's, named, and may pause
   or remove another's — never send it; the person's own have Send now.
3. **Live** on the person's own `billing.analytics.report` (`user:`, C-14):
   a send moves "last sent" without a poll. Billing's refusals
   (`not_allowed`, `too_many_schedules`, `rebuilding`) are sentences
   (`useReportError`).

