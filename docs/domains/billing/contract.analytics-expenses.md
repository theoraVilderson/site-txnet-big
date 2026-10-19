---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-19
---

# Contract — billing / analytics: general expenses (F-1001-t)

A topic file of [contract.analytics.md](contract.analytics.md). Asked for by
the user on 2026-10-19: profit until now was gross — what a tenant pays for
equipment, ads, staff, a domain or rent was recorded nowhere, so the Profit
tab read it as profit. Code: `billing-service/src/app/analytics/analytics-expense*.ts`,
the spread in `analytics-cost.ts` (`spreadExpenses`), the read in
`analytics-rollup-own-cost.ts`. The page is panel-web
[contract.analytics-tabs.md](../../interfaces/panel-web/contract.analytics-tabs.md) "Expenses".

## Storage (migration `20261019000100_a_general_expense_is_spread_as_overhead`)

`general_expense`: tenant, `category` (`equipment` / `advertising` / `staff` /
`domain` / `rent` / `other` — an enum the panel names, never free text),
`amount` (above 0, CHECK; at its currency's places), `currencyCode` (any
registered currency), `spentOn` (a tenant day), `months` (1..60, CHECK), an
optional `note` (1..200 characters), who added it and when.
`general_expense_take_back`: one row per expense (its key), who and when.
Both are **history** — a trigger refuses an UPDATE and the app is granted no
DELETE — and strict RLS on the tenant. Not derived: a rebuild never touches them.

## Routes — `/api/billing/tenants/:tenantId/analytics/expenses`

The analytics read bucket bounds all three.

| route | door | answers |
|---|---|---|
| `GET ?before=<id>` | `analytics.read` | `{expenses, more, currencyCode}` — the newest 50 first (created), taken-back ones included with `takenBackAt`; `before` pages past the one named; `currencyCode` the tenant's operating one, a new expense's default (F-1001-u) |
| `POST` | `settings.manage` (`platform.tenant.manage` on the platform's own) | the expense added — `{category, amount, currencyCode, spentOn, months?, note?}`, `.strict()` |
| `POST /:id/take-back` | as `POST` | the expense, `takenBackAt` set |

An expense is `{id, category, amount (decimal string), currencyCode, spentOn,
months, note, createdByUserId, createdAt, takenBackAt}`. Refusals:
`not_allowed`, `reseller_*` (the door's), `not_found`, `already_taken_back`
(409, a second take back — a racing one meets the key), `currency_not_registered`,
`amount_finer_than_currency`, `spent_in_future` (400).

## Rules

1. **Its own tenant's only.** Its owner and members, and on the platform's own
   tenant its staff. The platform's staff, whom the figures door lets in to a
   reseller, are refused `not_allowed` on every route: what a reseller spends
   is not a report about it. Read from how the door admitted, never the
   session's tenant — a reseller's owner signs in on the platform's.
2. **No edit.** A mistake is taken back and added again. A take back counts
   from the day the expense was paid: it is as if it never was.
3. **Spread over its months.** From `spentOn` to the same day `months`
   later (Gregorian; the 31st clamped to a shorter month's last day), each day
   an equal share at six places, the days summing to the amount exactly
   (`spreadExpenses`). Each pass writes the window's days as `kind overhead`
   in `analytics_cost_day` — no product, panel or user; one row per day and
   currency, every expense of it summed — converted as every cost row is
   (contract.analytics-tabs.md "Cost attribution" rule 5).
4. **A write restates.** An add or a take back asks the next pass to restate
   the tenant's cost rows from the expense's day (`restateCostsFrom`, rule 7
   there); its changed rows bump the version and announce
   `billing.analytics.refreshed`, which every open page re-reads on (C-14).
5. **Overhead is under the margin, not in it.** Every read of cost — the
   margin's totals, parts, series and cells, the loss alert, capacity — counts
   no `overhead`: no sale carries it. The Profit tab answers it apart
   (contract.analytics-tabs.md "Margin"): `totals.overhead` and
   `totals.netProfit` (margin − overhead), both `null` under a product, panel
   or fulfilment filter (an expense is no product's) and to the platform's
   staff on a reseller (rule 1).
