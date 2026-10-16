---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-16
---

# Contract — billing / analytics: Capacity (F-1005-a)

A topic file of [contract.analytics.md](contract.analytics.md): the principles,
the door, the cache and the export there hold here unchanged. Decided in
[ADR-0150](../../architecture/decisions/0150-capacity-is-an-analytics-tab-and-a-report-goes-to-one-person.md).
Code: `billing-service/src/app/analytics/analytics-capacity*.ts`,
`analytics-rollup-panels.ts`. The page is panel-web
[contract.analytics-tabs.md](../../interfaces/panel-web/contract.analytics-tabs.md).

## Rollup (migration `20261016000700_panel_capacity`)

On the rollup of the panel's **owner** — the platform's panels on the
platform's, a reseller's own on its own — read through the cross-tenant pool
(a panel serves every tenant's users), written in the owner's scope.

| table | grain | measure |
|---|---|---|
| `analytics_panel_traffic_day` (flow) | tenant · UTC date · panel | `bytes`: every tenant's users, from the network's daily aggregate |
| `analytics_panel_clients_day` (stock) | tenant · UTC date · panel | `clients`: Grants with a config not `retired` on it — what `maxClients` caps; a snapshot, written for today only by a pass that covers now; a panel in service with none is 0 |

A pass's fingerprint covers both (one UTC date past its range), so a moved
panel figure writes `billing.analytics.refreshed` like any other.

## `GET …/analytics/capacity`

The same query, door, cache and export as every tab. It answers the **UTC
month as of today**: a forecast has one now, so `from`, `to`, `compare` and
every filter but `panel` do not apply.

| field | what |
|---|---|
| `month`, `today` | the month's first day and today, UTC |
| `currencies` | as every tab |
| `panels` | one row per panel the tenant owns and has not retired, soonest full first, then by name |

A row: `panelId`, `name`; traffic `usedBytes` (the month before today),
`perDayBytes`, `projectedBytes`, `allowanceBytes`, `trafficFullOn`,
`observedDays`; users `clients`, `maxClients`, `clientsPerDay`,
`clientsFullOn`; `fullOn` and `daysUntilFull` (0 = today); money
`monthlyCostUsd` (today's price), `projectedCostUsd`, and `net`, `cost`,
`margin`, `marginRate`, `loss`. Bytes are decimal strings.

## Rules

1. **One forecast rule** (ai's, F-1525-a — shared-core `forecastSpanMs`): a
   rate is the mean of the last 7 complete UTC days, a younger panel's over its
   own days from its first traffic, none under a day. Today is never in it —
   its traffic lands a pass later.
2. **Traffic is a month's.** Projected = the month before today + the rate ×
   the days left (today included). Full on the day the rest of the allowance
   is used at the rate; a date past the month's end is none (the next month
   starts empty). Already past the allowance: full today.
3. **Users grow at the 7-day rate**, from the oldest snapshot inside 7 days.
   Full on the day the rate reaches `maxClients`; none when shrinking, with no
   cap, or past 90 days (`CLIENTS_HORIZON_DAYS`). At the cap: full today.
4. **The capacity is the price's.** `allowanceBytes` is the price in effect
   today's `monthlyTrafficBytes`; none set, no traffic full date — the
   projection is still answered.
5. **Money is the Profit tab's**, projected the same way: own net and own
   attributed cost per panel (contract.analytics-tabs.md "Margin" rule 1) in
   each currency, never across two. `projectedCostUsd` is the month at each
   day's price (`costOn`), exact rather than forecast. A panel with **no price
   in the month** answers `net`, `cost`, `margin` null — no cost, no margin,
   as Profit says "no cost set".
6. **Panels are not people**: nothing is hidden from the platform's staff.
