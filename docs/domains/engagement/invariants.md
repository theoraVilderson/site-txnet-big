---
id: engagement
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — engagement

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Total awarded value in a day never exceeds `spin_wheel_config.dailyBudgetCapAmount`, regardless of RNG | planned service layer / schema | see contract | 
| 2 | An attempt is recorded even when it is `rejected_ineligible` or `voided_fraud` — never dropped | planned service layer / schema | see contract | 
| 3 | `eligibilityCheckSnapshotJson` captures every check's result at spin time (disputes are settled from it, not re-evaluated) | planned service layer / schema | see contract | 
| 4 | A `wallet_credit` prize links to exactly one `billing.wallet_transaction` (`resultWalletTransactionId` unique) | planned service layer / schema | see contract | 
| 5 | `maxSpinsPerAccountPerDay` and `perUserCooldownHours` are both enforced | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
