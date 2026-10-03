---
id: engagement
layer: domain
status: draft
version: 1
updated: 2026-10-03
---

# Contract — engagement

**DRAFT — the wheel and the lottery have their tables and database guards
(F-707-a) but no writer yet; they will be a module of `billing-service`
(ADR-0111 point 1). The attention budget is implemented (F-1501), in
`ai-service`, its only writer (ADR-0109 point 10).**

## TL;DR

A daily wheel per tenant and free draws among a user group (ADR-0111), both
server-decided, neither ever paying cash. The wheel: a hard daily cost cap
(independent of the odds) and strict eligibility, every attempt snapshotting
its checks. The lottery: the entrant list frozen before the seed exists, the
draw made once and checkable from what is published.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| get wheel state | userId | eligibility result + prizes + remaining daily budget | sync | — |
| spin | userId, deviceFingerprintId | `spin_wheel_attempt` + prize, delivered in the same tx (F-707-b) | sync tx | ineligible, cooldown; over cap or out of stock is an `empty` result |
| issue a reward — **implemented (F-707-b)** | `issueReward(tx, grants, {tenantId, userId, source: spin\|lottery, referenceId, prize, actorUserId, at, grantId?})`, `billing-service/src/app/engagement/reward-issuer.ts` | `{rewardId, prizeType, replay, grantId, coupon}` | caller's tx | `RewardRefused`: `no_cash`, `no_active_grant`, `grant_not_eligible`, `coupon_template_unavailable`, `reference_reused`; the acts' own `EntitlementRefused` (`wholesale_unfunded`, `variant_not_deliverable`, …) |
| peek — **implemented (F-038-e)** | `AttentionBudget.peek(subject, now, pendingSends)`, the decision pipeline's budget step | the same verdict as `spend`, counting `pendingSends` as charged now; reads only, charges nothing, no lock | sync | — |
| spend attention — **implemented (F-1501)** | `AttentionBudget.spend({tenantId, kind, id}, origin, now)`, inside `ai-service` only | `{allowed: true, charged}` or `{allowed: false, limit: per_day \| per_week, retryAt}` | sync tx | — |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` | spin blocked |
| fraud | device fingerprint for the attempt | spin blocked (fingerprint required) |
| billing / entitlement | a prize: GB or days on the active Grant, a personal coupon, a free Grant (F-707-b) — never wallet credit | the spin's transaction fails; nothing is awarded |
| governance | a user group (F-114-j), read only: who may spin, who enters a lottery | the group's users are not offered it |

## The attention budget (F-1501) — implemented

`ai-service/src/app/attention/`. A subject (`user`, or a reseller as `tenant`)
may be charged once in any 24 h and three times in any 7 days, both windows
rolling from each charge, never by calendar day (`ATTENTION_WINDOWS`). `spend`
inserts the row if missing, locks it `FOR UPDATE`, checks, and charges in one
tenant-bound transaction: two decisions racing for one subject cannot both
take the last slot. A refusal writes nothing; `retryAt` is when both windows
have room. Charges older than 7 days are dropped on the next charge. A count,
never money (C-13). No other service reads or writes the table. Only an
`engine` origin is charged; a `reply` is allowed and touches nothing (F-1502).

## The storage rules (F-707-a) — built, held by the database

`20261003000200_the_wheel_is_versioned_and_a_draw_happens_once`; every table
strict tenant RLS. What a writer may rely on, and may not get round:

| Rule | Refusal |
|---|---|
| A wheel version and its prizes are never changed or deleted; prizes are written in the version's own transaction. An edit is a new `version` from the next tenant day (TZ-1) | `spin_wheel_is_history` |
| The day's `costSpent` never passes the version's cap; a prize's day count never passes its stock. Rows per tenant day, locked `FOR UPDATE`; no reset job | `spin_wheel_over_cap`, `spin_wheel_out_of_stock` |
| An awarded spin holds `seq` 1..n, unique per (tenant, user, tenant day); a refused one holds no seq, no prize, and a reason. `idempotencyKey` unique per user. Written once | `spin_wheel_attempt_shape`, unique, `spin_wheel_attempt_is_history` |
| No cash: `wallet_credit` is refused on every prize row; `resultWalletTransactionId` stays null. Each kind has its shape (GB > 0, whole days, a coupon's template + percent + days, a free Grant's variant, an empty slot free) | `engagement_prize_shape` |
| A row's user, fingerprint, group and prizes are its own tenant's and its own version's or lottery's | `engagement_tenant_mismatch` |
| A lottery moves `draft → published → frozen → drawn`, or to `cancelled` from draft or published with a reason; after publish only its status changes, prizes are fixed, entrants change until the freeze | `lottery_status_one_way`, `lottery_frozen`, `lottery_cancel_reason` |
| One draw per lottery (its key), made from a published lottery; never changed but for `publishedAt`, once. A winner keeps its place | `lottery_draw_is_history` |

## The reward issuer (F-707-b) — built

| Rule | Why |
|---|---|
| 1. Bonus GB: a prepaid bag via `adjustGrantTraffic`, a metered bag via `giftGrantBytes` as the reseller's own gift; source `engagement_reward` | a reseller's Grant buys it wholesale, as its staff's raise or gift (F-118-p, F-311-l) |
| 2. Extra days via `changeGrantDuration` on a Grant with an end; the change row names the prize's admin | days are `endsAt`, not a quota (§4.5) |
| 3. GB and days need an `active` Grant that can take them; none → `no_active_grant`, never queued. The caller's `grantId`, else the one running longest (no end first) | a prize waiting for a purchase is a prize for buying |
| 4. Coupon: cloned from the tenant's own template (ADR-0110), percent = lower of template and prize, a fixed template's amount as cap; single use, this user only, `validDays` | never more than the tenant offers |
| 5. Free Grant via `issueGrantByAdmin`, `requestId` = reference, source `engagement_reward`, inside a reseller's own limits (`bounded`) | the wheel is the reseller's own hand-out |
| 6. Once per (source, referenceId): `reward_issue` unique; a retry answers `replay: true`, another user or prize `reference_reused` | a retried spin never pays twice |
| 7. `wallet_credit` → `no_cash`; `empty` is not an issue | ADR-0111 point 2 |

## Guarantees (intended)

- Eligibility is evaluated fresh on every spin from live data, then frozen into the attempt.
- The pick is `crypto.randomInt` over the version's weights; the client only animates (ADR-0111 point 4).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
