---
id: engagement
layer: domain
status: draft
version: 1
updated: 2026-10-03
---

# Contract — engagement

**DRAFT — the wheel and the lottery have their tables and database guards
(F-707-a); `billing-service`'s `engagement/` module (ADR-0111 point 1) writes
the wheel's versions (F-707-c), its spins (F-707-d), its day report (F-707-e) and a user's history (F-707-g), nothing of the lottery yet. The attention budget is implemented (F-1501), in
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
| manage the wheel — **implemented (F-707-c)** | `engagement.manage`; `GET /api/billing/engagement/wheel`, `POST …/wheel/versions` (config, eligibility, group, prizes in slot order), `GET …/versions/:version` | `{today, inForce, next, history}`; a version with `expectedCostPerSpin` | sync tx | `invalid_prize`, `invalid_amount`, `expected_cost_over_cap`, `prize_cost_over_cap` (400); `coupon_template_not_found`, `variant_not_found`, `group_not_found`, `version_not_found` (404); `version_taken` (409) |
| the wheel's day report — **implemented (F-707-e)** | `engagement.manage`; `GET /api/billing/engagement/wheel/report?from=&to=` (tenant days, inclusive, default today, at most 31) | per day, newest first: `{day, version, spins, refused, refusals{reason: n}, nothing, prizes[{prizeId, position, label, prizeType, count, cost}], costSpent, cap, currencyCode, capUsedPercent, alertedAt}` | sync | `invalid_range` (400) |
| the user's wheel — **implemented (F-707-d)** | `GET /api/billing/wheel`; the caller and its device | `{tenantDay, version, prizes[] with oddsPercent, eligible, refusalReason, spinsLeftToday, nextSpinAt}`; writes nothing | sync | `no_wheel` (404) |
| the user's history — **implemented (F-707-g)** | `GET /api/billing/wheel/history`; the caller | the caller's own attempts, newest 30: `{attemptId, at, tenantDay, status, refusalReason, prize{label, prizeType, prizeValue}, coupon{code, expiresAt}}` — never the checks; writes nothing | sync | — |
| spin — **implemented (F-707-d)** | `POST /api/billing/wheel/spin {requestId, grantId?}`; the device from the request (F-036-a) | `{attemptId, status, refusalReason, seq, position, prize, reward, replay}` — a refused spin is a recorded `200` | sync tx | `no_wheel` (404), `no_fingerprint` (400), `spin_in_progress` (409) |
| issue a reward — **implemented (F-707-b)** | `issueReward(tx, grants, {tenantId, userId, source: spin\|lottery, referenceId, prize, actorUserId, at, grantId?})`, `billing-service/src/app/engagement/reward-issuer.ts` | `{rewardId, prizeType, replay, grantId, coupon}` | caller's tx | `RewardRefused`: `no_cash`, `no_active_grant`, `grant_not_eligible`, `coupon_template_unavailable`, `reference_reused`; the acts' own `EntitlementRefused` (`wholesale_unfunded`, `variant_not_deliverable`, …) |
| peek — **implemented (F-038-e)** | `AttentionBudget.peek(subject, now, pendingSends)`, the decision pipeline's budget step | the same verdict as `spend`, counting `pendingSends` as charged now; reads only, charges nothing, no lock | sync | — |
| spend attention — **implemented (F-1501)** | `AttentionBudget.spend({tenantId, kind, id}, origin, now)`, inside `ai-service` only | `{allowed: true, charged}` or `{allowed: false, limit: per_day \| per_week, retryAt}` | sync tx | — |

## Emits (events)

| Event | When | Payload |
|---|---|---|
| `tenant.engagement.wheel_cap_nearing` (F-707-e) | the spin whose prize brings the tenant day to 80% of the cap; once a day (`spin_wheel_day.capAlertedAt`, set under the day lock), one event per active user whose role holds `engagement.manage` or `*` | `{tenantId, userId, day, spent, cap, currencyCode}`; worker-service tells `wheelCapNearing` (automation `contract.outbox.md`) |

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

## The wheel's settings (F-707-c) — built

`engagement/wheel-admin.service.ts`, behind `EngagementPermissionGuard`
(`engagement.manage`, granted to `Admin`); RLS is the boundary.

| Rule | Why |
|---|---|
| 1. A save is a new `version`, effective from the tenant's next calendar day (`tenant-day.ts`: the tenant's zone through `resolveTimeZone`, never the user's). In force on a day: the highest version whose first day is not after it | a day half spun keeps its odds and cap (point 4) |
| 2. Refused when Σ weight × cost / Σ weight is over the cap, or one prize costs more than the whole cap | the odds shown must be the odds given, not `empty` by noon |
| 3. Each prize has its kind's shape (the database's `prize_shape_ok`, answered as `invalid_prize`); `wallet_credit` is refused; an `empty` slot costs 0 | no cash (point 2) |
| 4. A coupon template is the tenant's own, not deleted, not a gift-code batch's; a variant is active and visible; a group is the tenant's | a prize the reward issuer could not give |
| 5. Prizes are written in the version's transaction, positions 1..n in the order sent; the currency is the tenant's operating one (ADR-0098) | `spin_wheel_is_history` refuses a later prize |
| 6. Every save is audited: `spin_wheel_version_create` on `spin_wheel_config`, the whole version as `newValue` | who changed the odds, and to what |
| 7. Budgets per admin: `ENGAGEMENT_ADMIN_READ` 120 / `_WRITE` 30 per 15 min | as every admin surface |

## The spin (F-707-d) — built

`engagement/wheel-spin.service.ts`, `wheel.controller.ts`; any signed-in user.

| Rule | Why |
|---|---|
| 1. A `requestId` already recorded answers that attempt (`replay: true`; the issuer's replay names the coupon again) and spins nothing | a retried tap never spins twice |
| 2. No version in force today, or one switched off: `no_wheel`; a device that cannot be told: `no_fingerprint` — both record nothing | an attempt names a version and a fingerprint |
| 3. The tenant's day row is created if missing and locked `FOR UPDATE` before the user's spins today and the cooldown are counted | two taps cannot both take the last spin |
| 4. Every check is gathered fresh and frozen into `eligibilityCheckSnapshotJson.checks`, required or not: active account, age, phone, active Grant, paid invoices in the version's currency (sum and count), group, open fraud flag, device under 5 accounts, spins today, cooldown since the last awarded spin | disputes read what was true (invariant 3) |
| 5. The first failed check refuses: recorded with no seq and its reason, `voided_fraud` for `flagged`/`shared_device`, else `rejected_ineligible` | invariant 2 |
| 6. `crypto.randomInt(Σ weight)` walked over the slots in position order | server-decided, the shown odds |
| 7. Over the cap, past the prize's stock (its day row locked too), or refused by the issuer (`RewardRefused`, `EntitlementRefused`, rolled back to a savepoint) → nothing: `prizeAwardedId` null, cost 0, `position` the first `empty` slot. Counters move only for a prize given | the cap holds whatever the RNG (invariant 1) |
| 8. The prize is issued as `source: spin`, `referenceId` the attempt, by the version's creator, in the spin's transaction | F-707-b rule 6 |
| 9. Budgets per user, never shared: `WHEEL_READ` 120 / `WHEEL_SPIN` 20 per 15 min | ADR-0070 |
| 10. The report (`wheel-report.ts`) counts a refused attempt by its reason, never as a spin; an awarded spin with no prize (an `empty` slot, or a pick over the cap or stock) as `nothing`; cost from the attempts, spent and cap from the day row and its version | the admin sees what the day really gave |

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
