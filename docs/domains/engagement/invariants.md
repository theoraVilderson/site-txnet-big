---
id: engagement
layer: domain
status: draft
updated: 2026-10-03
---

# Invariants — engagement

**DRAFT** — 1, 2, 4, 7–9 are held by the database (F-707-a); 1, 3 and 5 also by the spin (F-707-d, `wheel-spin.service.ts`); 6 is enforced in `ai-service`.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Total awarded cost in a tenant day never exceeds the version's `dailyBudgetCapAmount`, nor a prize its daily stock, regardless of RNG | triggers `spin_wheel_over_cap` / `spin_wheel_out_of_stock` | over-spend |
| 2 | An attempt is recorded even when it is `rejected_ineligible` or `voided_fraud` — never dropped, never changed | `spin_wheel_attempt_is_history`; the write is F-707-d's | disputes unsettleable |
| 3 | `eligibilityCheckSnapshotJson` captures every check's result at spin time (disputes are settled from it, not re-evaluated) | `checkEligibility` + `WheelSpinService`; `wheel-spin.spec.ts` | disputes unsettleable |
| 4 | No cash, ever: no `wallet_credit` prize, no wallet transaction on an attempt (ADR-0111 point 2) | `engagement_prize_shape`, `spin_wheel_attempt_shape` | winnings pooled by fake accounts |
| 5 | `maxSpinsPerAccountPerDay` and `perUserCooldownHours` are both enforced; an awarded spin's `seq` is unique per (tenant, user, tenant day) | the unique; the bound and the cooldown counted under the day row's lock (`WheelSpinService`) | extra spins |
| 6 | A subject is charged for at most 1 proactive AI message in any rolling 24 h and 3 in any rolling 7 days; a refused message is not charged; concurrent decisions cannot overspend | `AttentionBudget.spend` (row lock + `budgetVerdict`); `attention-budget.spec.ts` | users nagged; the budget drains with nothing sent |

| 7 | A wheel version and its prizes never change once written | `spin_wheel_is_history` | a day's odds changed mid-day |
| 8 | A lottery is frozen once published and moves one way; cancelling needs a reason | `lottery_guard`, `lottery_parts_guard`; `LotteryAdminService` answers each with a reason (`lottery-admin.spec.ts`) | an operator steers the draw |
| 9 | A draw happens once and is never rewritten; its seed is made only after the list is frozen, in the freeze's transaction | key + `lottery_draw_is_history`; `LotteryCloseService` (`lottery-close.spec.ts`) | a re-roll until the right winner |
| 10 | A prize is given once per (source, reference), in the caller's transaction; GB and days only to an active Grant now, never queued | `reward_issue` unique + `issueReward`; `reward-issuer.spec.ts` | a prize paid twice, or held for a purchase |

## How to test

Attention budget: `ai-service/src/app/attention/attention-budget.spec.ts`. Wheel and lottery storage: `billing-service/src/app/engagement/engagement-schema.int.spec.ts` (`npm run test:int`). Rewards: `reward-issuer.spec.ts`. Settings: `wheel-admin.spec.ts`, `lottery-admin.spec.ts`. Lottery entry and close: `lottery-entry.spec.ts`, `lottery-close.spec.ts`. Spin: `wheel-spin.spec.ts`.
