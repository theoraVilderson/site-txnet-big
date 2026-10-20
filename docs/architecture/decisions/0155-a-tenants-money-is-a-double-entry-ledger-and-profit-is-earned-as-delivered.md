---
id: adr-0155
status: active
updated: 2026-10-20
---

# ADR 0155 — A tenant's money is a double-entry ledger beside the wallets, and profit is earned as it is delivered

- **Status:** accepted
- **Date:** 2026-10-20
- **Decision:** the user's (2026-10-20: "so I spend only from my own share,
  never from users' wallets or from what the servers need, and stop worrying
  whose money this is"; every recommended option taken: earned on delivery,
  a double-entry ledger, every tenant, opening at the start of the current
  month, a metered block earned as served, partners built now and used later)
- **Affects units:** billing (the ledger, the records, the reads), panel-web
  (the money view), automation (one worker job), network (cost, via ADR-0156)
- **Spec:** [billing/contract.money-ledger.md](../../domains/billing/contract.money-ledger.md),
  [panel-web/contract.money-balance.md](../../interfaces/panel-web/contract.money-balance.md).
  Rows F-1008 and F-1008-a … F-1008-ab.

## Context

Every top-up lands in the owner's own accounts (a gateway, a card, later a
crypto wallet). Nothing says how much of that cash is the owner's:

- user wallets are single-entry rows per owner (`WalletTransaction`); no house
  account sums what users hold, so their money is spendable by mistake;
- a package counts as revenue on the day it is bought (`IS_SALE`,
  `revenue/reseller-revenue.service.ts`), yet a cancel refunds its unused part
  (`traffic/prepaid-remainder.ts`) — profit taken early is profit paid back;
- the Profit tab (`analytics-margin.ts`) is a report: it records no tax, no
  owner draw, no provider prepayment, and cannot be checked against a bank;
- infrastructure cost is one flat monthly USD price per panel (ADR-0156 fixes it).

## Decision

1. **One double-entry ledger per tenant, beside the wallets.** Accounts,
   entries and lines in the billing schema; every entry balances per currency
   (a deferred trigger); append-only (a trigger refuses UPDATE and DELETE); a
   correction is a new entry that reverses the old one. The wallets, the
   tenant billing ledger and every money path stay as they are: the ledger is
   **projected** from their committed rows by a worker pass (idempotent key
   `(tenant, sourceKind, sourceId, leg)`), never written inside a payment's
   transaction. Derived postings (earning, cost, tax) post the change needed to
   reach a target, so a restatement is a new leg, never an edit.
2. **Profit is earned as the service is delivered.**
   - A package: earned = `total × max(volume share used, time share elapsed)`
     — the refund formula, one pure core shared with `prepaid-remainder.ts`, so
     what is earned and what a cancel refunds can never disagree. The rest is
     **unearned** (a liability). On close, a true-up sets the grant's unearned to 0.
   - A prepaid metered block (`traffic_consumption`, a prepaid `usage_charge`):
     unearned when debited, earned as `GrantMeter`'s consumed cursor passes it.
   - A postpaid capture is earned when captured. A reseller's wholesale cost
     charged at sale is deferred and released at the same share.
3. **Cash is split, always, into five parts:**
   `cash = user money (wallets + held + unearned) + taxes owed + other payables
   + reserve + withdrawable`. Only **settled** cash counts — money still at a
   gateway or in transit between the owner's accounts is shown, not
   withdrawable. A provider's prepaid credit is the owner's asset, not cash:
   topping it up lowers withdrawable at once; consuming it lowers profit, not
   withdrawable. A negative withdrawable means user or tax money was spent,
   and alerts.
4. **Reserve:** `reservePercent` (default 20) of the expected cost of the
   unconsumed volume of open grants, held out of withdrawable, released as it
   is consumed.
5. **Expected profit is fixed at delivery** (`GrantCostExpectation`: the cost
   per byte of the grant's panel's sources on that day, pessimistic per
   ADR-0156). The difference with the actual cost is its own line, "server
   price variance", never hidden inside margin.
6. **Tax is never profit.** Sales tax charged on top (`taxApplied`) is a
   liability on settlement; for tax-inclusive prices `salesTaxIncludedPercent`
   splits it out of earned revenue; input tax on a provider charge is cost
   unless its source is marked deductible; `incomeTaxPercent` (default 0) of
   each month's earned profit is reserved (change-to-target, a loss month
   lowers it); a `TaxPayment` clears the liability. Rates are settings only.
7. **The owner records only what no system knows**: money accounts and their
   real balances (reconciliation; an accepted difference posts with a reason),
   transfers between own accounts (fee and FX gain or loss on their own line),
   provider top-ups (ADR-0156), capital contributions, draws, tax payments,
   a cash refund to a user's card (wallet reason `cash_refund`). Every manual
   record names who made it; each is reversed, never edited.
8. **Partners exist from day one.** A tenant has parties with dated shares
   summing to 100; it starts with one party, its owner, at 100. Earned profit
   after tax is split per day by the shares in effect that day. Draws,
   contributions and a personal cost source name their party. A party's
   withdrawable is the total's equity share, capped at its own equity; a draw
   above it shows the party owing the business.
9. **The books open on the first day of the month the opening runs**: wallet
   balances, unearned of open grants, settlement owed, tenant billing
   balances from the source tables; account balances entered by the owner; the
   difference is opening equity. History before it is not replayed.
10. **A month closes** after reconciliation; later corrections post on the
    current open day, never into a closed month.
11. **Every tenant has its own books.** `money.read` and `money.manage`
    are new keys; platform staff viewing a reseller see only its debt to the
    platform, never its money view.
12. **The Profit tab stays** the sales margin on `analytics_*`; the ledger
    feeds only the money view and "earned profit". The two are never summed,
    and infrastructure cost has one source, `analytics_cost_day` (ADR-0156).

## Consequences

- Ledger lines grow 2–4 per wallet row; a `LedgerBalanceDay` snapshot is added
  only if the balance read is measured slow.
- Earned profit and the Profit tab's margin differ by timing; the money view
  says which is which.
- A fixed `user_wallets` liability makes "spend user money" visible, not
  impossible — the owner still holds the cash; the alert is the control.
- Order and scope: rows F-1008-a … F-1008-ab, `docs/BACKLOG.md` "Order of
  work — the F-1008 money series".
