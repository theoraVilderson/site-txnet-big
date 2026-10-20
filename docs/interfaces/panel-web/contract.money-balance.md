---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-20
---

# Contract — panel-web: the money balance under Profit (F-1008-f, -p, -q, -ab)

A topic file of [contract.analytics-tabs.md](contract.analytics-tabs.md).
**Spec, not yet built.** Why: ADR-0155, ADR-0156. Data:
[billing/contract.money-ledger.md](../../domains/billing/contract.money-ledger.md),
[billing/contract.cost-sources.md](../../domains/billing/contract.cost-sources.md).
Every label is a locale key (C-19); every amount is `moneyText` in its own
currency (ADR-0153), the operating-currency figure beside it.

## Where

Views under the Profit tab group in `analytics/_lib/filters.ts`:
`TAB_VIEWS.margin = ["margin", "expenses", "money", "money-sources",
"money-accounts", "money-partners", "money-ledger"]` — each its own `?tab=`,
on `/analytics` and `/reseller/analytics`. Shown only with `money.read`; the
forms only with `money.manage`. They read no filter bar range except
`money-ledger`. Each view re-reads on `billing.ledger.posted` with
`useLiveReread` (C-14); no polling. Files: `_components/money/*`,
`_lib/money.ts`, `site-pwa/src/lib/billing/money.ts` (the client), split by
job (C-20).

## `money` — the balance (F-1008-p)

Before opening (`{opened:false}`): a setup card — add accounts, then "open the
books on <first of month>" with each account's balance on that day
(`POST open`).

A currency switch in the view's header (any registered currency, default the
operating one; `?currency=` in the URL) — USD shows what the money is worth
in dollars. After: one stacked bar of settled cash in five parts (user money, taxes,
payables, reserve, withdrawable — dataviz kit, ADR-0150 colours), then cards:

1. **Withdrawable** — the big number; negative turns it into the shortfall
   warning "user or tax money was spent: N".
2. **Users' money** — wallets, held, unearned.
3. **Taxes owed** — sales, income; "record a payment".
4. **Provider credit** — per account: estimated left, days left (warning at
   `lowCreditDays`), "record a top-up".
5. **Earned profit** — earned, infrastructure cost, estimate corrections,
   server price variance, commission, overhead, income tax, net; a line saying
   it differs from the Profit tab's sales margin by timing. Below net, apart:
   realized and unrealized FX gain or loss.
6. **My share** (one party) or **Partners** (more) — equity, drawn, withdrawable,
   "owes the business".
7. **FX exposure** — per currency: held, owed, expected cost of unconsumed
   volume; a currency owed more than held is marked.
8. **Flags** — estimated splits, unfunded sources, unassigned expenses,
   unaccepted balance differences — each a link to its form.

## `money-sources` (F-1008-f)

List of cost sources: kind, purpose badge (platform / overhead / personal),
panels, funding account, current price in words ("32,000 a day · 200 GB in
free, reset unknown · 950 per GB in"), last ratio. The form, one page:
kind → purpose → label, currency, GB size (1024 / 1000) → panels (platform
only, the tenant's own) → funding account → party (personal only) → price:
fixed amount + period; allowance bytes + meter + reset ("I don't know" is the
default and says "counted as paid until a top-up proves otherwise"); price per
GB in and out; input tax deductible. Advanced (collapsed): `meterMap`.
A price change is "new price from <date>" (`POST :id/prices`), never an edit.
The systems panel page's `PanelCost.tsx` becomes a read-only list of the
panel's sources with a link here.

## `money-accounts` and the forms (F-1008-q)

Accounts list with book balance, last real balance and its difference. Forms
(sheets, each `money.manage`):

| form | fields |
|---|---|
| account | kind, label, currency, gateway (kind gateway), default |
| real balance | account, amount, as of; then accept with a reason |
| provider top-up | provider account, from account, amount, **balance before** → the preview lists the account's sources with their estimate and an optional actual amount each; `unregistered_usage` shows the difference with "assign to" (a source or overhead) |
| transfer | from, to, amount out, amount in (own currency each), fee |
| draw / contribution | account, amount, party (hidden with one party), note |
| tax payment | kind, period, amount, account |
| cash refund to a user | user (search), amount ≤ free balance, account, reason, proof |
| close month | the month; refused with the accounts still unaccepted |
| reversal | from any manual row's menu: reason |
| settings | reserve %, income tax %, tax-included %, low-credit days (in `AnalyticsSettingField`) |

## `money-partners` (F-1008-ab)

Parties and their dated shares: add a partner (name, optional linked user);
"new shares from <date>" with one percent per party, the sum shown live and
the save refused unless 100. Per party: capital, profit share, drawn, equity,
withdrawable. With one party the view shows "My share" only.

## `money-ledger`

The ledger lines for the range, filter by account, newest first, 50 a page;
each line links to its source (payment, invoice, top-up, draw…).
