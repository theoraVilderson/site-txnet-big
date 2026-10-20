---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-20
---

# Contract — billing / cost sources and provider top-ups (F-1008-c … -f, -l, -r)

A topic file of [contract.analytics.md](contract.analytics.md). **Spec, not yet
built.** Why: [ADR-0156](../../architecture/decisions/0156-infrastructure-cost-is-a-source-estimated-pessimistically-and-trued-up-from-the-provider.md).
Replaces [network/contract.panel-cost.md](../network/contract.panel-cost.md)
once F-1008-r lands. Ledger postings: [contract.money-ledger.md](contract.money-ledger.md) §3.

## 1. Storage (F-1008-c)

`network` schema, beside `panel_cost`, written by billing's systems module as
`panel_cost` is today; strict RLS on `tenantId` (the owning tenant: the
platform for platform panels, a reseller for its dedicated ones).

| table | columns |
|---|---|
| `cost_source` | `id`, `tenantId`, `kind` (`server` / `cdn` / `other`), `purpose` (`platform` / `overhead` / `personal`), `label` 1..60, `currencyCode` (any registered), `gbUnitBytes` BigInt (default `METERED_RATE_UNIT_BYTES`; the form offers 1024³ or 1000³), `partyId?` (required iff `personal`), `meterMap` json `{in:{up,down}, out:{up,down}}` (coefficients ≥ 0, default all 1), `retiredAt?`, `createdAt`, `createdBy` |
| `cost_source_panel` | `sourceId`, `panelId`, `effectiveFrom`, `effectiveTo?`; only for `platform`; a panel of another tenant refused |
| `cost_source_funding` | `sourceId`, `moneyAccountId` (kind `provider_credit`), `effectiveFrom` — history: moving a source to another account is a new row |
| `cost_source_price` | `sourceId`, `effectiveFrom` (a date, not before the open month — as `panel_cost` today), `fixedAmount` ≥ 0, `fixedPeriod` (`hour` / `day` / `month`), `allowanceBytes` ≥ 0, `allowanceMeter` (`in` / `out` / `total`), `allowanceAnchor` date? + `allowancePeriodDays` int? (both null = reset **unknown**), `pricePerGbIn` ≥ 0, `pricePerGbOut` ≥ 0 `DECIMAL(18,8)`, `inputTaxDeductible` bool |
| `provider_top_up` | `id`, `tenantId`, `providerAccountId`, `fromAccountId`, `amount`, `balanceBefore`, `occurredAt`, `createdBy` |
| `provider_top_up_share` | `topUpId`, `sourceId` or `overhead`, `amount` (actual), `inputTax` ≥ 0, `how` (`entered` / `fixed` / `remainder` / `estimated`) |
| `provider_charge` | a postpaid invoice: `sourceId`, `periodFrom`, `periodTo`, `amount`, `inputTax`, `accountId` |

All history (UPDATE refused); a mistake is reversed (`money_reversal`).
Migration of `panel_cost`: one `platform` source per panel (kind `server`,
USD, `fixedAmount = monthlyCostUsd`, `fixedPeriod = month`, no allowance, the
same `effectiveFrom` history), one `cost_source_panel` row, no funding (the
money view lists it as "unfunded" until the owner names an account).

## 2. The estimate (F-1008-d)

`systems/cost-source-bill.ts`, pure: `billSourceDays(prices, days)` where a day
is `{day, up, down}` summed over the source's panels from
`network.traffic_daily_aggregate` (`totalUploadBytes`, `totalDownloadBytes`,
joined config → panel). Per day, in order:

1. `in = in.up·up + in.down·down`, `out` likewise (`meterMap`), `total = in + out`.
2. fixed: `month` → `fixedAmount ÷ daysInMonth`; `day` → `fixedAmount`; `hour` → `× 24`.
3. allowance: reset unknown → 0. Known → a cycle starts on `anchor + k·periodDays`;
   the cycle's allowance is consumed by `allowanceMeter` bytes in day order.
4. variable: `(in bytes past allowance if the meter is in or total) ×
   pricePerGbIn ÷ gbUnitBytes` + the same for `out` — with meter `total` the
   allowance is taken from `in` first, then `out`.
5. each day priced by the price row in effect that day.

A source with no panel (`overhead`, `personal`) has no bytes we can see: its
estimate is the fixed part only, and the money view marks its variable part
"not measured" — the top-up's entered amount (or the remainder) is its truth.

Returns per day `{fixed, variableIn, variableOut, inBytes, outBytes}`. Rounded
once per ADR-0153 into `analytics_cost_day` (6 places).

## 3. Allocation in the rollup (F-1008-e)

`analytics-rollup-cost.ts` / `analytics-cost.ts`: `platformPanelCosts` and the
per-panel price are replaced by sources. Per source per day: variable `in`
split over the users of its panels by their `in` bytes, `out` by `out` bytes,
fixed by total bytes (three `splitWhole` calls); no traffic → one `idle` row
on the source. `analytics_cost_day` gains `sourceId`. Purpose `platform` rows
are kind `panel`; `overhead` rows kind `overhead` (no user); `personal` rows
are not written (they are not the tenant's cost). Reseller-owned panels: the
reseller's sources, in its books (the `ownershipType = 'platform'` filter goes).
The capacity read (`analytics-capacity*.ts`) reads a panel's month cost from
its sources' estimate instead of `monthlyCostUsd`. The true-up (§5) writes kind
`estimate_adjust` on the top-up day, split over the interval's users by their
share of that source's estimate in the interval.

## 4. Routes — `/api/billing/tenants/:tenantId/money/cost-sources` (F-1008-c, -l)

Doors as [contract.money-ledger.md](contract.money-ledger.md) §5.

| route | body / answer |
|---|---|
| `GET` | sources with current price, panels, funding account, last true-up ratio, `estimatedLeft`, `daysLeft` |
| `POST` | `{kind,purpose,label,currencyCode,gbUnitBytes?,partyId?,meterMap?,panelIds[],fundingAccountId?,price}` |
| `POST :id/prices` | a new price row (§1) |
| `POST :id/panels` | `{panelIds[], effectiveFrom}` — the full set from that day |
| `POST :id/funding` | `{moneyAccountId, effectiveFrom}` |
| `POST :id/retire` | the source stops costing from tomorrow |
| `GET /money/provider-top-ups/preview?providerAccountId&balanceBefore` | the interval since the last top-up, its sources with estimates, and the drop |
| `POST /money/provider-top-ups` | `{providerAccountId,fromAccountId,amount,balanceBefore,shares:[{sourceId|'overhead',amount?,inputTax?}]}` |

## 5. The true-up (F-1008-l)

On a top-up: `drop = (balance after the previous top-up) − balanceBefore`
(the first top-up of an account: the opening balance of §7 of the ledger
spec). The drop is split over the sources funded by the account in the
interval, in order: `entered` amounts; a source with only a fixed price and no
entered amount takes exactly its fixed cost (`fixed`); if one source is left it
takes the remainder (`remainder`); else the remainder is split by estimate
(`estimated`, flagged on the money view). When every source has an entered
amount and they do not sum to the drop, the request is refused
`unregistered_usage` with the difference; the form assigns it to a source or
`overhead` and resubmits. Per source: `adjust = estimate − actual` (posted per
§3 of the ledger spec), `ratio = actual ÷ estimate` kept for `GET`. The next
interval's estimate of credit left: `balance after this top-up − Σ estimate
since`; `daysLeft = estimatedLeft ÷ average daily estimate of the last 7 days`.

## 6. Fixtures every spec uses

CDN 50 GB `out` allowance, reset unknown, 1,800/GB `out`, kind `cdn`, panels S1
and S2; S1 32,000/day, 200 GB `in` allowance, reset unknown, 950/GB `in`; S2
25,000/day, 900/GB `out`; P personal 15,000/day + 1,000/GB `out`, no panel —
all funded by one Arvan account. Week of 7 days: S1 80 GB, S2 40 GB of user
traffic (`meterMap` default, all as download). Estimates CDN 216,000 / S1
300,000 / S2 211,000 / P 105,000 (fixed only; not measured). Balance before
the second top-up 304,000 with entered 126,000 / 224,000 / 211,000 / 135,000 →
adjusts +90,000 / +76,000 / 0 on platform cost, and P's −30,000 lands on
`owner_draws` with its 135,000 (never platform cost). P left blank → 135,000
by remainder; P and S2 blank → 346,000 split by estimate (211 : 105), flagged.
