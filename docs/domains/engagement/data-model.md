---
id: engagement
layer: domain
status: draft
updated: 2026-10-03
---

# Data model — engagement

Source of truth: `txnet-backend/prisma/domains/engagement.prisma` (Postgres schema
`engagement`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| spin_wheel_config | one **version** of a tenant's wheel: `version`, `effectiveFromDay`, cap + `currencyCode`, eligibility, optional `userGroupId`; immutable | yes | permanent |
| spin_wheel_prize | a slot of a version: `position`, kind + value (+ coupon template / variant), weight, `costAmount`, optional daily stock; immutable | yes | permanent |
| spin_wheel_day | (tenant, tenant day): `costSpent`, `spins`, the version in force, `capAlertedAt` (the 80% alert, F-707-e) | yes | permanent |
| spin_wheel_prize_day | (prize, tenant day): `awardedCount` | yes | permanent |
| spin_wheel_attempt | one spin, refused too: version, tenant day, `seq`, `idempotencyKey`, snapshot, picked vs awarded prize, cost, reason; written once | yes | permanent (audit) |
| lottery | a draw among a user group: entry mode, close time, eligibility, reserves, status, cancel reason | yes | permanent |
| lottery_prize | rank, kind + value, `winnersCount` | yes | permanent |
| lottery_entrant | one user once; `ticketNumber` at the freeze or `excludedReason` | yes | permanent |
| lottery_draw | once per lottery, written at the freeze: list hash, sealed seed (ADR-0022), algorithm, `frozenAt`; `drawnAt` and `publishedAt` set later, once each | yes | permanent |
| lottery_winner | a place in the permutation: winner (`prizeId`) or reserve, delivery outcome | yes | permanent |
| reward_issue | one prize given: (source spin\|lottery, referenceId) unique, user, kind, and what it became (Grant + adjustment or duration change, coupon, free Grant); written once (F-707-b) | yes | permanent |
| attention_budget | recent proactive AI-message times per subject (`chargedAt[]`, user or tenant) — 3 per rolling 7 days, 1 per 24 h (F-1501, ADR-0109 point 10); written by `ai-service` only; a count, never a ledger account (C-13); strict tenant RLS | yes | while the subject exists |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| spin_wheel_attempt.userId | -> | identity.user.id | spins are per user |
| spin_wheel_attempt.deviceFingerprintId | -> | fraud.device_fingerprint.id | multi-account defence |
| spin_wheel_attempt.resultWalletTransactionId | -> | billing.wallet_transaction.id | kept, never set (ADR-0111 point 2: no cash) |
| spin_wheel_config / lottery .userGroupId | -> | governance.user_group.id | read only; a trigger refuses another tenant's (no FK) |
| *_prize.couponTemplateId / variantId | -> | billing.coupon / catalog.product_variant | plain ids, as `ai.offer`; resolved by the reward issuer (F-707-b) |

## Access rules

Wheel and lottery: written only by `billing-service`'s `engagement/` module,
in the caller's tenant transaction — `spin_wheel_config` and `spin_wheel_prize`
by `WheelAdminService` (F-707-c); `spin_wheel_day`, `spin_wheel_prize_day`, `spin_wheel_attempt` by `WheelSpinService` (F-707-d); `lottery` and `lottery_prize` by `LotteryAdminService` (F-707-i); `lottery_entrant` opt-ins by `LotteryEntryService` (F-707-j); tickets and exclusions, `lottery_draw`, and `lottery.status = frozen` by `LotteryCloseService` (F-707-k); `lottery_winner`, `lottery_draw.drawnAt`/`publishedAt` and `status = drawn` by `LotteryDrawService` (F-707-l); a winner's `delivery`, `deliveredAt`, `passedOnReason` and a reserve's `prizeId`/`replacesWinnerId` by `LotteryDeliveryService` (F-707-m). No unit outside `engagement` writes them. `attention_budget` is read and written only by
`ai-service`'s `AttentionBudget`, on the app pool with the tenant bound (F-1501).

## Migration notes

`20261003000200_the_wheel_is_versioned_and_a_draw_happens_once` (F-707-a):
the wheel versioned, day counters, the five lottery tables, every guard in
contract.md "The storage rules", RLS. `currentDayAwardedCount` dropped (the
tables were empty; the migration refuses to run otherwise).
`20261003000300_a_prize_is_given_once` (F-707-b): `reward_issue`, its shape
CHECK, write-once trigger, RLS; `GrantSource.engagement_reward`.
`20261003000400_a_tenant_admin_runs_its_wheel` (F-707-c): `engagement.manage`
to `Admin`, the audit values. `20261003000500_the_wheel_warns_at_80_percent`
(F-707-e): `spin_wheel_day.capAlertedAt`. Both additive.
`20261003000600_a_tenant_admin_runs_its_lotteries` (F-707-i): the `lottery_*`
audit actions and the `lottery` target. Additive.
`20261003000700_the_seed_is_sealed_at_the_freeze` (F-707-k): `lottery_draw.drawnAt`
nullable, the guard allowing `drawnAt` then `publishedAt` once each, and
`lottery_draw_published_after_drawn`.
