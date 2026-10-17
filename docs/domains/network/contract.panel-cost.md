---
id: network
layer: domain
status: active
version: 1
updated: 2026-10-16
---

# Contract — network / what a panel costs a month (F-1002-a)

A topic file of [contract.md](contract.md), opened because that file is at its
cap. The platform's cost of a panel, the figure analytics spreads over a
month's days and splits by traffic (F-1002-b,
[billing/contract.analytics.md](../billing/contract.analytics.md) "Cost and
margin"). Table `network.panel_cost` (`20261016000300_a_panel_carries_its_monthly_cost`);
code `billing-service/src/app/systems/panel-cost*.ts`, on the systems surface.

## Operations

| Operation | Input | Output | Errors |
|---|---|---|---|
| `GET /api/billing/systems/panels/:id/cost` | — | `{current, history}`: the price in effect today (or `null`) and every row, newest first, each `{monthlyCostUsd, monthlyTrafficBytes, effectiveFrom, createdByUserId, createdAt}` | 403 `not_platform_owner`; 404 `not_found` |
| `POST /api/billing/systems/panels/:id/cost` | `{monthlyCostUsd, monthlyTrafficBytes?, effectiveFrom?}` — USD as a decimal string, ≤ 2 places, ≥ 0; the month's traffic that price buys, whole bytes as a string > 0, left out = none set (F-1005-a); a UTC day, default today | the same as `GET`, the new row in it | 400 `cost_in_closed_month`; 404 `not_found`; 409 `panel_retired` |

The panel list (`GET …/systems/panels`) carries each panel's `monthlyCost` —
the price in effect today, or `null`.

## Rules

| # | Rule |
|---|---|
| 1 | **A price is history, not a setting.** A change adds a row; a trigger refuses an update. The rows go only with their panel (a panel that never served is deleted, F-027-bz). |
| 2 | **A closed month never moves.** `effectiveFrom` is never before the first day of the current UTC month, so what a past month cost — and every margin read from it — is fixed when it closes. The current month may be corrected; a future price may be set ahead. A write asks analytics to restate the platform's cost rows from its day (`restateCostsFrom`, F-1002-e), so a correction reaches days already rolled. |
| 3 | **The price on a day** is the row with the latest `effectiveFrom` on or before it; two rows of one day are settled by the later written (`costOn`, `panel-cost-on.ts` — the one reading of it). No row: no cost set, which analytics says as `no cost set`, never as 0. `0` is a free panel. |
| 4 | **The panel's owner sets it** on the systems surface: `platform.node.manage` at the guard and the panel in the actor's scope (ADR-0080 decision 2) — today the platform's own panels. Written on the platform owner's pool, as every panel write is; read on the app pool, visible exactly when its panel is (RLS through `network.panel`). |
| 5 | USD always: a panel is bought in dollars whatever the tenant sells in. Analytics converts nothing (its principle 6) — the cost series is its own currency. |
| 6 | **The allowance is the price's** (F-1005-a, ADR-0150): history with it, read on a day as the price is (rule 3). Analytics' capacity forecast reads it; nothing enforces it on the panel. |
