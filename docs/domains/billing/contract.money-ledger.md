---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-20
---

# Contract — billing / money ledger and the money balance (F-1008)

A topic file of [contract.analytics.md](contract.analytics.md). **Spec, not yet
built** — each section names the row that builds it. Why: ADR-0155 (ledger,
earning, tax, partners) and ADR-0156 (infrastructure cost; its own spec is
[contract.cost-sources.md](contract.cost-sources.md)). The page:
[panel-web/contract.money-balance.md](../../interfaces/panel-web/contract.money-balance.md).

## 1. Storage (F-1008-g; records F-1008-m, -t, -u, -v, -w, -aa)

All in the `billing` schema, strict RLS on `tenantId` like `general_expense`
(app granted SELECT, INSERT only), every write inside `tenantTransaction`.

| table | columns (besides `id`, `tenantId`, `createdAt`, `createdBy` where manual) |
|---|---|
| `ledger_account` | `code` (enum §2), `subKey` text? (gateway / money account / source / party / grant / counterparty tenant id), `currencyCode`; unique `(tenantId, code, subKey, currencyCode)` NULLS NOT DISTINCT; created on first use |
| `ledger_entry` | `day` (UTC date, as the rollup's), `occurredAt`, `sourceKind` (enum §3), `sourceId` uuid, `leg` smallint; unique `(tenantId, sourceKind, sourceId, leg)` |
| `ledger_line` | `entryId`, `accountId`, `amount` `DECIMAL(20,6)` signed (debit +), `currencyCode`, `userId?`, `productId?`, `panelId?`, `grantId?`; index `(tenantId, accountId, day)` via entry |
| `ledger_cursor` | `(tenantId, sourceKind)` key, `lastCreatedAt`, `lastId` |
| `money_account` | `kind` (`bank` / `gateway` / `crypto` / `cash` / `provider_credit`), `label` 1..60, `currencyCode`, `gatewayId?` / `tenantGatewayConfigId?` (a gateway's settlement lands here), `isDefault` (exactly one per tenant: where an unassigned outflow is paid from), `retiredAt?` |
| `money_account_balance` | `accountId`, `amount`, `asOf` (timestamp), `note?`, `acceptedAt?`, `acceptReason?` |
| `money_transfer` | `fromAccountId`, `toAccountId`, `amountOut`, `amountIn` (each in its account's currency), `fee` (in `from` currency, ≥ 0), `note?` |
| `owner_draw` / `capital_contribution` | `partyId`, `accountId`, `amount`, `note?` |
| `tax_payment` | `kind` (`sales` / `income`), `periodFrom`, `periodTo`, `amount`, `accountId` |
| `cash_refund` | `userId`, `amount` (wallet currency), `accountId`, `reason` 1..200, `proofRef?`, `walletTransactionId` |
| `grant_cost_expectation` | `grantId` unique, `costPerByte` `DECIMAL(30,18)`, `currencyCode`, `sources` json (source id, price row id) |
| `party` / `party_share` | party: `name`, `userId?`; share: `effectiveFrom`, `partyId`, `percent` `DECIMAL(7,4)`; a trigger refuses a date whose shares do not sum to 100 |
| `money_month` | `month` (first day), `closedAt`, `closedBy` |

Every manual table is history: a trigger refuses UPDATE; a mistake is a row
in `money_reversal` (`targetKind`, `targetId`, `reason`) that posts the exact
negation. `AnalyticsSetting` gains `reservePercent` (0..100, default 20),
`incomeTaxPercent` (0..100, default 0), `salesTaxIncludedPercent` (0..100,
default 0), `lowCreditDays` (1..60, default 3) — `analytics-settings.ts`.

## 2. Accounts (`code`)

Assets: `cash_account` (per money account), `cash_clearing` (per gateway, not
yet settled), `in_transit` (a transfer sent, not received), `provider_credit`
(per provider account), `vat_input`, `settlement_receivable`, `platform_prepaid`.
Liabilities: `user_wallets`, `unearned` (per grant), `reseller_balances`,
`settlement_payable`, `tax_payable_sales`, `tax_payable_income`, `deferred_wholesale`.
Income: `revenue_package`, `revenue_metered`, `revenue_wholesale`, `fee_income`, `fx_gain`.
Expense: `infra_cost` (per source), `infra_estimate_adjust` (per source),
`gateway_commission`, `wholesale_cost`, `overhead`, `promo_expense`,
`income_tax_expense`, `reconciliation_diff`, `fx_loss`.
Equity: `capital` (per party), `owner_draws` (per party), `opening_equity`,
`fx_conversion` (bridges two currencies inside one entry).

## 3. Posting map (`sourceKind` → lines; Dr / Cr)

| source (row) | lines |
|---|---|
| `payment` success on own gateway (-i) | Dr `cash_clearing`[gw] charged / Cr `user_wallets` credited + Cr `tax_payable_sales` tax + Cr `fee_income` fee; a discount Dr `promo_expense` |
| `gateway_commission` per payment (-i) | Dr `gateway_commission` / Cr `cash_clearing`[gw] (`gatewayCommissionCosts`); negative → swapped |
| borrowed gateway, settlement, payout (-i) | `settlement_payable` / `settlement_receivable` both sides (ADR-0041) |
| `gateway_settled` (-u) | Dr `cash_account` / Cr `cash_clearing`[gw] — recorded by the owner as a transfer from the gateway's account |
| `wallet_tx` `product_purchase` (-h) | Dr `user_wallets` / Cr `unearned`[grant] |
| `earning` grant × day (-k) | Dr `unearned`[grant] / Cr `revenue_package` (+ `salesTaxIncludedPercent` share to `tax_payable_sales`) |
| `wallet_tx` `product_refund` (-h) | Dr `unearned`[grant] / Cr `user_wallets`; at close a true-up leg zeroes the grant |
| `wallet_tx` `traffic_consumption`, prepaid `usage_charge` (-h, -k) | Dr `user_wallets` / Cr `unearned`[grant]; as served: Dr `unearned` / Cr `revenue_metered` |
| `traffic_refund`, `usage_refund` (-h) | Dr `unearned`[grant] / Cr `user_wallets` |
| postpaid `usage_charge` capture (-h) | Dr `user_wallets` / Cr `revenue_metered` |
| `coupon_redemption`, gift, compensation credit (-h) | Dr `promo_expense` / Cr `user_wallets` |
| `currency_change` (-h) | through `fx_conversion` |
| `cash_refund` (-v) | Dr `user_wallets` / Cr `cash_account` |
| tenant billing rows (-j) | platform: `reseller_balances` ↔ `revenue_wholesale` / cash; reseller: `wholesale_cost` or `deferred_wholesale` ↔ `platform_prepaid` |
| `infra_estimate` source × day (-l) | Dr `infra_cost` / `overhead` / `owner_draws`[party] by purpose / Cr `provider_credit`[account] |
| `provider_top_up` (-l) | Dr `provider_credit` / Cr `cash_account`; the true-up per source: Dr/Cr `provider_credit` against `infra_estimate_adjust` (purpose `overhead` → `overhead`, `personal` → `owner_draws`) |
| `general_expense` (-m) | Dr `overhead` / Cr `cash_account` — the expense gains `accountId?`; null → the default account, flagged `unassignedExpenses` |
| `owner_draw`, `capital_contribution` (-m, -w) | Dr `owner_draws`[party] / Cr `cash_account`; Dr `cash_account` / Cr `capital`[party] |
| `money_transfer` (-u) | Dr `cash_account`[to] amountIn, Dr `fx_loss` fee / Cr `cash_account`[from] amountOut + fee; cross-currency through `fx_conversion`, the difference at the day's rate (ADR-0152) to `fx_gain` / `fx_loss` |
| `income_tax` month (-t) | Dr `income_tax_expense` / Cr `tax_payable_income` = `incomeTaxPercent` × the month's earned profit, change-to-target |
| `tax_payment` (-t) | Dr `tax_payable_*` / Cr `cash_account` |
| balance accepted (-m) | Dr/Cr `cash_account` real − book against `reconciliation_diff` |
| `opening` (-n) | every opening balance against `opening_equity` |

No posting for a pending payment or a hold (a hold stays the user's money).

## 4. Projector (F-1008-h)

`POST /api/internal/billing/money/project` (internal key, like
`analytics/refresh`), called every 5 minutes by worker job `money_ledger`
(automation, beside `analytics-rollup.job.ts`). Per pass: up to
`TENANTS_PER_PASS` tenants round-robin, one `tenantTransaction` each; per source
table, rows with `createdAt < now() − 2 min` after the cursor, re-reading a
10-minute overlap (the key absorbs repeats); at most 500 rows per source per
tenant per pass (C-28). Derived kinds (earning, estimate, income tax) are
computed for closed UTC days up to yesterday. Writes the outbox event
`billing.ledger.posted` (one per tenant per pass, only when it inserted) — an
`EventNotice` to the tenant's audience (ADR-0121, C-14). A closed month is never
posted into: a derived leg for it lands on the first open day.

## 5. Routes — `/api/billing/tenants/:tenantId/money` (F-1008-m, -o, -t, -u, -v, -w, -y, -z, -aa)

Doors: read `money.read`; write `money.manage`; `cash-refunds` also
`wallet.manual_adjust`. Keys added in `auth-handler/configs/permissions.yaml`
(+ `reseller-keys.ts`, the `finance` preset in `group-presets.ts`,
`python3 tools/permissions-gen.py`) by F-1008-z. Platform staff on a reseller's
id: 403 except `GET balance?scope=platform-debt`.

| route | body / answer |
|---|---|
| `GET balance` | §6 |
| `GET ledger?account&from&to&before` | lines, newest 50 first |
| `GET/POST accounts`, `POST accounts/:id/retire` | `{kind,label,currencyCode,gatewayId?,tenantGatewayConfigId?}` |
| `POST accounts/:id/balances`, `POST balances/:id/accept` | `{amount,asOf,note?}` → `{book, real, difference}`; accept `{reason}` |
| `POST transfers` | `{fromAccountId,toAccountId,amountOut,amountIn,fee?,note?}` |
| `POST draws`, `POST contributions` | `{accountId,amount,partyId?,note?}` (party defaults to the owner party) |
| `POST tax-payments` | `{kind,periodFrom,periodTo,amount,accountId}` |
| `POST cash-refunds` | `{userId,amount,accountId,reason,proofRef?}` — debits the wallet (reason `cash_refund`, free balance only) and records the row in one transaction |
| `POST reversals` | `{targetKind,targetId,reason}` |
| `POST months/:month/close` | refused while an account's latest balance is unaccepted for that month |
| `GET/POST parties`, `POST parties/shares` | `{effectiveFrom,shares:[{partyId,percent}]}`, not before an open day |
| `POST open` | §7 |

Provider top-ups and cost sources: [contract.cost-sources.md](contract.cost-sources.md).

## 6. The balance read (F-1008-o)

In the tenant's operating currency at today's rate (ADR-0152), each part also
per original currency:

`{cash:{settled, inTransit, atGateways}, userMoney:{wallets, held, unearned},
taxes:{sales, income}, payables:{settlement, providerShortfall}, reserve,
withdrawable, providerCredit:[{accountId, estimatedLeft, daysLeft}],
profit:{earned, infraCost, estimateAdjust, priceVariance, commission,
overhead, incomeTax, net}, personalSpend, parties:[{partyId, equity, drawn,
withdrawable, owes}], flags:{estimatedSplit[], unassignedExpenses, shortfall}}`.

`withdrawable = settled − userMoney − taxes − payables − reserve`.
`reserve = reservePercent × Σ open grants (unconsumed bytes × costPerByte)`.
`priceVariance = Σ consumed bytes × (actual allocated cost per byte − costPerByte)`.
A party's withdrawable = `withdrawable × equity ÷ Σ equity`, at most its equity.

## 7. Opening and close (F-1008-n, -y)

`POST open {date}` once per tenant, `date` the first day of the current month:
wallets (`balanceAfter` as of the date), unearned of grants open then (§3 core),
`owed()` of settlements, `TenantBillingWallet` balances, and the owner's
`money_account_balance` rows as of the date (required for every account) →
`opening` entry, the difference `opening_equity`. Before it, `balance` answers
`{opened:false}`. Close (§5) locks a month.

## 8. Alerts (F-1008-x)

Daily, through the loss alert's path (`analytics-loss.ts` → bot + inbox), once
per kind per day: a provider account's `daysLeft ≤ lowCreditDays`;
`withdrawable < 0`; an unaccepted balance difference older than 7 days.

## 9. Acceptance scenario (F-1008-o spec)

Settings: reserve 20, income tax 10, sales tax 10 on top, commission 1%.
CDN 50 GB free (out, reset unknown) 1,800/GB; server 32,000/day, 200 GB free
(reset unknown) 950/GB; both one panel, each its own provider account.

| step | event | settled cash | withdrawable |
|---|---|---|---|
| 1 | open, bank 3,000,000 | 3,000,000 | 3,000,000 |
| 2 | top-ups 500,000 + 500,000 (balance before 0) | 2,000,000 | 2,000,000 |
| 3 | users top up 4,000,000 + tax 400,000, commission 44,000; the gateway's settlement recorded as a transfer to the bank | 6,356,000 | 1,956,000 |
| 4 | packages 3,000,000 (150 GB), reserve 82,500 | 6,356,000 | 1,873,500 |
| 5 | 7 days, 120 GB, earned 1,400,000, estimate 554,000, income tax 80,200 | 6,356,000 | 3,259,300 |
| 6 | top-ups again, balances before 374,000 / 276,000: adjust +204,000, tax +20,400 | 5,356,000 | 2,238,900 |
| 7 | draw 1,500,000 | 3,856,000 | 738,900 |
| 8 | sales tax paid 400,000 | 3,456,000 | 738,900 |
| 9 | bank real 3,450,000, accepted −6,000 (income tax −600) | 3,450,000 | 733,500 |

Shared account variant: the CDN's account also funds a personal source; at
step 6 the form enters 80,000 for it, balance before 294,000 — platform cost,
profit, tax and withdrawable unchanged; `personalSpend` 80,000. Holds at every
step: each entry balances; `settled = userMoney + taxes + payables + reserve +
withdrawable`; `withdrawable = capital − providerCredit + profit after tax −
draws − reserve`.
