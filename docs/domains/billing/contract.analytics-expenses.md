---
id: billing
layer: domain
status: active
version: 2
updated: 2026-10-19
---

# Contract — billing / analytics: general expenses and gateway commission (F-1001-t, F-1001-v)

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

## Gateway commission (F-1001-v)

Asked for by the user on 2026-10-19: a gateway's `feeApplied` is passed to
the payer, and what the provider itself deducts from the merchant was
recorded nowhere — so a fee the tenant absorbed was invisible. Code:
`payment/gateway-admin/gateway-commission*.ts`, the arithmetic in
`analytics-cost.ts` (`gatewayCommissionCosts`), the read in
`analytics-rollup-own-cost.ts`. The field is panel-web's gateway editor (F-1001-w).

**Storage** (`20261019000200_a_gateway_carries_its_providers_commission`):
`gateway_commission` — exactly one of `gatewayId` / `tenantGatewayConfigId`
(CHECK), `tenantId` the gateway's owner, `percent` (0..100, four places),
`fixedAmount` (≥ 0) in `currencyCode` — the gateway's own, set by the
service — `effectiveFrom` (a tenant day), who and when. History as an
expense: the same trigger refuses an UPDATE, no DELETE grant, strict RLS.

**Routes** — `…/gateways/:source/:id/commission` on both gateway surfaces,
`/api/billing/gateways` and the named reseller's `/api/billing/tenants/:tenantId/gateways`
(where a reseller's owner works — it signs in on the platform's tenant),
behind `gateway.manage` and the gateway-admin buckets:

| route | answers |
|---|---|
| `GET` | `{commissions, inEffect, currencyCode}` — the newest 50 by `effectiveFrom` then created; `inEffect` the id a payment made today is costed by, `null` before the first; `currencyCode` the gateway's |
| `POST` | the row added — `{percent, fixedAmount, effectiveFrom}`, decimal strings, `.strict()`; one `gateway_update` audit row `{source, commission}` |

A row is `{id, percent, fixedAmount, currencyCode, effectiveFrom,
createdByUserId, createdAt}`. Refusals as gateway management's:
`gateway_not_found` (404), `invalid_range` (400, a fixed amount finer than
the gateway currency's places).

6. **The caller's own gateway only.** A platform gateway is the platform
   owner's; a tenant's gateway its tenant's — **not** the platform owner's,
   who manages every gateway but whose report a reseller's costs are not
   (rule 1). Anything else is `gateway_not_found`; on the named reseller's
   surface the platform's staff, whom its door admits, are `not_allowed`.
7. **No edit.** A change is a row from its day on; `0` and `0` stops
   counting. A payment is costed by the row with the latest `effectiveFrom`
   on or before its tenant day (the later-added on a tie); none before a
   gateway's first row — no row is "not set", never 0.
8. **What a payment costs.** Every `success` payment of the tenant on a
   gateway it owns, no grant, something charged: the percent of what the
   payer was charged — `amountCredited − discountApplied + feeApplied +
   taxApplied`, `payable` as `gateway-pricing.ts` built it — plus the fixed
   amount, less `feeApplied`. Below zero is a gain and stays (a fee charged
   above what the provider takes). A granted gateway's payment is left out:
   it landed in the lender's account, and the settlement nets the fee there
   (ADR-0041 §4).
9. **One row per day and currency**, `kind gateway`, no product, panel or
   user — a top-up is no sale; the fixed part in the gateway's currency, apart
   from the percent's when the two differ; converted as every cost row is.
   An add asks the next pass to restate from `effectiveFrom` (rule 4).
10. **Below the margin**, as overhead (rule 5): the Profit tab answers it as
   `totals.gatewayCommission`, and `totals.netProfit` is margin − overhead −
   it; both `null` where `overhead` is.
