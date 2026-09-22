---
id: billing
layer: domain
status: active
version: 2
updated: 2026-09-22
---

# Contract — billing / a reseller's own revenue

A topic file of `contract.md` (§10): what one reseller sold and what its users
paid in, over a period. **ADR-0067** is the why, and it is short: three ledgers
here can each be called revenue and none of them agrees with the others.

This is not settlement. `/api/billing/admin/settlement/*` (F-096-e,
`domains/audit/contract.settlement.md`) answers the **platform owner** what it
owes a tenant whose gateway collected for it — a debt, a different number, a
different audience. It is not reused, re-scoped or extended here.

## The surface

`GET /api/billing/tenants/:tenantId/revenue?from=&to=` (`revenue/`, F-311-b).
The reseller is the **path's**, never the session's: its owner signs in to the
platform owner's tenant (ADR-0059). Consumers: bot-app (F-311-c), and a panel
page when one is built.

| Rule | Why |
|---|---|
| `ResellerAccess.admit`/`run` is the whole door (tenant invariant 21) — the reseller's owner, a staff seat of it holding `tenant.manage`, or platform staff. **No permission guard**, and `read` not `staffWrite` | a reseller's owner holds no operator permission; a suspended reseller may still see what it earned |
| The refusal reasons are the door's four, mapped `not_allowed` 403, `reseller_not_found` 404, `reseller_suspended` 403, `reseller_terminated` 409 | the shape every reseller-named surface answers, so one client reads them all |
| **The scope is the whole filter.** The work runs inside `ResellerAccess.run`, and no query names a `tenantId` | both tables are strict under RLS (`20260909001500`, list C) *and* in `TENANT_SCOPED_MODELS`; a filter written by hand is one that can be written wrong, and the failure is a reseller reading another's takings |
| Two figures, answered together, neither folded into the other: `sales` (what its users spent) and `topUps` (what they paid in) | a user who tops up 100 and spends 40 is 40 of revenue and 100 of cash in — ADR-0067 decision 1 |
| **Gross.** What the platform charges this reseller is not subtracted | it lives in `tenant_billing_transaction` on a different clock (F-019-a/b); the subtraction would reconcile to no row. Read it at F-019-j |
| A sale is a **debit with a sale reason**, and `IS_SALE` classifies every `WalletReasonType` exhaustively. Today only `traffic_consumption` qualifies | a new reason must be judged before it compiles. `wallet_transfer_out` is excluded because two users passing money back and forth would otherwise manufacture revenue; `sub_account_charge` because the consumption charged out of that wallet is already counted |
| **A refund of a sale comes off it**, and `UNDOES` names, exhaustively, which sale each credit undoes. Today only `traffic_refund` -> `traffic_consumption` (F-027-r). It is subtracted from that reason's total and from `sales.total`; `count` is untouched | the blocks were bought ahead of consumption and the unconsumed ones go back when the Grant closes (ADR-0072 rule 3). A figure that took the debits and ignored the credits would report every reseller more than it kept, by the headroom this platform holds — and grow with the number of Grants that expire, which is all of them. The rows were still sold, so what changed is the money, not the count |
| A window holding a close whose blocks were bought earlier reports a **negative** reason, and is not clamped to zero | the figure is the movement in the window; a zero would be a number no rows back, and it would hide exactly the period a reseller asks about |
| `topUps` counts `status: success` and `billingTenantId: null` only | a `pending` or `failed` attempt is not money — the arithmetic legacy got wrong (`contract.history.md`); a row with `billingTenantId` is the reseller paying **the platform** (F-019-b), money out |
| Amounts are base-currency decimal strings, two places (C-02, ADR-0019). An empty period is `0.00`, never `null` | a report with a hole in it is read as a zero anyway, and a string cannot be rounded in transit |
| The `sales.total` is summed from the `byReason` rows already read, not asked for a second time | a second aggregate is a second chance for the total and its parts to disagree |
| Nothing is cached or stored | the ledger says what was earned; a remembered total is a second memory (the reasoning of ADR-0041 §5) |
| The window defaults to 30 days, is capped at 366 by the schema, and the answer echoes the `from`/`to` actually used. Its own rate-limit bucket, `RESELLER_REVENUE_READ` | two aggregates scan the tenant's whole ledgers over the period with no index narrowing them further — the most expensive read on any reseller-named surface |
| `.strict()` on the query | the path already said whose revenue this is; a second answer is refused rather than ignored |

## What it does not answer yet

**`sales.total` is `0.00` today, and will be until `entitlement` is built.**
Nothing writes a `traffic_consumption` row: `entitlement` is `draft`, schema
only (F-026-b), which is the same gap that blocks F-311-d. The surface is
complete and its arithmetic is proved; its headline number is empty.

`topUps` is real today. A consumer built before `entitlement` lands — F-311-c is
the first — shows that figure and says what it is, rather than showing a zero
labelled revenue.
