---
id: engagement
layer: domain
status: draft
updated: 2026-10-02
---

# Invariants — engagement

**DRAFT** — 1–5 are extracted from schema comments and not enforced yet; 6 is enforced in `ai-service`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Total awarded value in a day never exceeds `spin_wheel_config.dailyBudgetCapAmount`, regardless of RNG | planned service layer / schema | see contract | 
| 2 | An attempt is recorded even when it is `rejected_ineligible` or `voided_fraud` — never dropped | planned service layer / schema | see contract | 
| 3 | `eligibilityCheckSnapshotJson` captures every check's result at spin time (disputes are settled from it, not re-evaluated) | planned service layer / schema | see contract | 
| 4 | A `wallet_credit` prize links to exactly one `billing.wallet_transaction` (`resultWalletTransactionId` unique) | planned service layer / schema | see contract | 
| 5 | `maxSpinsPerAccountPerDay` and `perUserCooldownHours` are both enforced | planned service layer / schema | see contract | 
| 6 | A subject is charged for at most 1 proactive AI message in any rolling 24 h and 3 in any rolling 7 days; a refused message is not charged; concurrent decisions cannot overspend | `AttentionBudget.spend` (row lock + `budgetVerdict`); `attention-budget.spec.ts` | users nagged; the budget drains with nothing sent |

## How to test

Attention budget: `ai-service/src/app/attention/attention-budget.spec.ts`. Spin wheel: when a service exists.
