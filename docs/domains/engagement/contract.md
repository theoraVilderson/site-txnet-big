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
the wheel's versions (F-707-c), its spins (F-707-d), its day report (F-707-e) and a user's history (F-707-g), a lottery's drafts, publish and cancel (F-707-i), a user's entry (F-707-j), the close (F-707-k), the draw (F-707-l) and the delivery and public result (F-707-m); the panel (F-707-f/g) and the bot (F-707-h) are its surfaces. The attention budget is implemented (F-1501), in
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
| manage lotteries — **implemented (F-707-i)** | `engagement.manage`; `/api/billing/engagement/lotteries`: `GET`, `GET :id`, `POST` and `PUT :id` (a whole draft: group, title, description, `entryMode`, `closesAt`, eligibility, `reservesCount`, prizes in rank order), `DELETE :id`, `POST :id/publish`, `POST :id/cancel {reason}`; reads `GET :id/eligibility`, `GET :id/winners` (F-707-o) | a lottery with its prizes, `entrantCount`, `winnersTotal`; `204` on delete; eligibility `{asOf, final, members, eligibleMembers, candidates, eligible, excluded{reason: n}, skippedResellerCount}`; winners `{entrantCount, frozenAt, drawnAt, publishedAt, places[{position, ticketNumber, user{id, fullName, username}, prize, delivery, deliveredAt, passedOnReason, replacesPosition}]}` | sync tx | `invalid_prize`, `invalid_close_time`, `cancel_reason_required` (400); `coupon_template_not_found`, `variant_not_found`, `group_not_found`, `lottery_not_found` (404); `not_a_draft`, `not_cancellable`, `not_drawn` (409) |
| a lottery's result — **implemented (F-707-m)** | `GET /api/billing/lotteries/:id/result`; the caller, as the list's rule 4 | `{lotteryId, title, algorithm, seed, listHash, entrantCount, prizes[{rank, label, winnersCount}], reservesCount, frozenAt, drawnAt, tickets[{ticketNumber, entrantId}], places[{position, ticketNumber, prize{rank, label}, delivery, passedOnReason, replacesPosition}], mine{entrantId, ticketNumber, excludedReason}}` | sync | `lottery_not_found` (404); `not_drawn` (409) |
| the user's lotteries — **implemented (F-707-j)** | `GET /api/billing/lotteries`; `POST` / `DELETE …/:id/entry`; the caller | list: the published lotteries of its groups and any it has an entrant row in, newest close first, 30: `{id, title, entryMode, status, closesAt, cancelReason, open, prizes, entry{optedInAt, ticketNumber, excludedReason}}`; entry: `{lotteryId, joined, optedInAt, replay}` | sync tx | `lottery_not_found` (404); `not_opt_in`, `closed` (409) |
| close, draw and deliver lotteries — **implemented (F-707-k, -l, -m)** | `POST /api/internal/billing/engagement/lotteries/close-due`, `ServiceOnlyGuard`; worker `lottery_close`, every minute: the freezes, the draws, then the deliveries | `{scanned, frozen, drawn, delivered, failed}` | sync, one tx per lottery per step | a 404 to anyone but a service |
| the user's wheel — **implemented (F-707-d)** | `GET /api/billing/wheel`; the caller and its device | `{tenantDay, version, prizes[] with oddsPercent, eligible, refusalReason, spinsLeftToday, nextSpinAt}`; writes nothing | sync | `no_wheel` (404) |
| the user's history — **implemented (F-707-g)** | `GET /api/billing/wheel/history`; the caller | the caller's own attempts, newest 30: `{attemptId, at, tenantDay, status, refusalReason, prize{label, prizeType, prizeValue}, coupon{code, expiresAt}}` — never the checks; writes nothing | sync | — |
| spin — **implemented (F-707-d)** | `POST /api/billing/wheel/spin {requestId, grantId?}`; the device from the request (F-036-a) | `{attemptId, status, refusalReason, seq, position, prize, reward, replay}` — a refused spin is a recorded `200` | sync tx | `no_wheel` (404), `no_fingerprint` (400), `spin_in_progress` (409) |
| issue a reward — **implemented (F-707-b)** | `issueReward(tx, grants, {tenantId, userId, source: spin\|lottery, referenceId, prize, actorUserId, at, grantId?})`, `billing-service/src/app/engagement/reward-issuer.ts` | `{rewardId, prizeType, replay, grantId, coupon}` | caller's tx | `RewardRefused`: `no_cash`, `no_active_grant`, `grant_not_eligible`, `coupon_template_unavailable`, `reference_reused`; the acts' own `EntitlementRefused` (`wholesale_unfunded`, `variant_not_deliverable`, …) |
| peek — **implemented (F-038-e)** | `AttentionBudget.peek(subject, now, pendingSends)`, the decision pipeline's budget step | the same verdict as `spend`, counting `pendingSends` as charged now; reads only, charges nothing, no lock | sync | — |
| spend attention — **implemented (F-1501)** | `AttentionBudget.spend({tenantId, kind, id}, origin, now)`, inside `ai-service` only | `{allowed: true, charged}` or `{allowed: false, limit: per_day \| per_week, retryAt}` | sync tx | — |

## Emits (events)

| Event | When | Payload |
|---|---|---|
| `engagement.lottery.won` (F-707-m) | a winner place `delivered`, in the delivery's transaction; once per place | `{tenantId, userId, lotteryId, title, prize, rank}`; worker-service tells `lotteryWon` (automation `contract.outbox.md`) |
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
| One draw per lottery (its key), written at the freeze with its seed; never changed but for `drawnAt` then `publishedAt`, each once (20261003000700). A winner keeps its place | `lottery_draw_is_history`, `lottery_draw_published_after_drawn` |

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

## The lotteries' settings (F-707-i) — built

`engagement/lottery-admin.service.ts`, behind `EngagementPermissionGuard`
(`engagement.manage`); RLS is the boundary. No route closes, freezes, seeds or
draws a lottery: that is the close job's alone (F-707-k, F-707-l).

| Rule | Why |
|---|---|
| 1. A draft is rewritten whole (`PUT`, prizes too) or deleted; anything else is `not_a_draft` | users enter knowing what for (point 5) |
| 2. Publish fixes group, prizes, close time and rules; from then the only admin act is cancel | the admin cannot steer the list it sees forming |
| 3. Cancel from `draft` or `published` with a trimmed, non-empty reason users are shown; after the freeze `not_cancellable` | the seed exists only after the freeze |
| 4. `closesAt` at least 1 h and at most 180 days ahead, at save and again at publish (the bound rides in the publish write) | time to opt in; a prize that outlives its offer |
| 5. A prize has its kind's shape (`prize-shape.ts`, shared with the wheel); never `empty`, never `wallet_credit`; `winnersCount` ≥ 1; ranks 1..n in the order sent | every place drawn is a prize; no cash (point 2) |
| 6. Group, coupon template and variant must be the tenant's (as the wheel's rule 4); the group checked again at publish | a deleted group never opens |
| 7. Every state change is a write conditional on the status; a lost race answers its reason | two admins, or an admin and the close job |
| 8. Audited on `lottery`: `lottery_create`, `_update`, `_delete`, `_publish`, `_cancel`; budgets `ENGAGEMENT_ADMIN_READ` / `_WRITE` | as the wheel's rules 6, 7 |
| 9. The two reads (F-707-o, `lottery-admin-report.service.ts`) move nothing. Eligibility before the freeze runs the close's own `lotteryCandidates` and `judgeCandidate` now — an estimate — and judges every user member too (an `opt_in` lottery's reach); after it, the frozen list | the preview counts as the freeze will |
| 10. Winners only once `drawn`, else `not_drawn`; the admin sees each place's user, the public result never does | the admin learns no place before the users |
| 11. Publish writes `engagement.lottery.published` `{tenantId, lotteryId, title, entryMode}` in its transaction (F-707-q); `GET internal/…/lotteries/:id/audience` (`ServiceOnlyGuard`, `lottery-audience.service.ts`) pages the group's user members, empty once cancelled or closed | the group is told only of a publish that committed, and never after the lottery stops ([automation contract.notices.md](../automation/contract.notices.md)) |

## A user's entry (F-707-j) — built

`engagement/lottery-entry.service.ts`, `lottery.controller.ts`; any signed-in user.

| Rule | Why |
|---|---|
| 1. Join or leave only an `opt_in` lottery, while `published` and before `closesAt`; else `not_opt_in` / `closed` | an `automatic` one takes every eligible member at the close |
| 2. One entry per user: the database unique; a repeat join, or one that lost the race to its own retry, answers the kept entry with `replay: true`; a repeat leave too | twice in the list is twice the chance |
| 3. The lottery row is read `FOR SHARE`; the close job takes it `FOR UPDATE` | an entry is in the frozen list or refused, never written after the tickets |
| 4. A user member of the group may join; an entrant taken out of the group may still leave; anyone else, and any draft, is `lottery_not_found` | a lottery is shown only to its group |
| 5. Eligibility is not judged here, but at the close (F-707-k) | what counts is what is true when the list is frozen |
| 6. Free; budgets per user, never shared: `LOTTERY_READ` 120 / `LOTTERY_ENTRY` 30 per 15 min | ADR-0111 point 6, ADR-0070 |

## The close (F-707-k) — built

`engagement/lottery-close.service.ts` behind `lottery-internal.controller.ts`;
the worker's `lottery_close` tick is the only caller (ADR-0111 point 5).

| Rule | Why |
|---|---|
| 1. One transaction per lottery, `published` and past `closesAt`, locked `FOR UPDATE`: entrants written, list hashed, **then** `randomBytes(32)` sealed (`lottery-seed-seal.ts`, KEK-derived, ADR-0022) into the draw row (`drawnAt` null), then `frozen` | the seed never exists beside a list that can move, and a rerun cannot make a second (user, 2026-10-03) |
| 2. Candidates: `automatic`, every user member of the group; `opt_in`, who joined. A reseller member never enters and is counted (`skippedResellerCount`) | point 6 |
| 3. First failed rule is kept as `excludedReason`: `not_in_group`, `inactive`, `account_too_new`, `phone_unverified`, `flagged`, `shared_device` (a device behind 5 accounts in 30 days, D-11). No device recorded is no bar (user, 2026-10-03) | each member can see why |
| 4. Tickets 1..n to the eligible by entry time, then user id | fair in any order: no seed exists yet |
| 5. `listHash` = SHA-256 hex of `txnet-lottery-list-v1\n<lotteryId>\n` + `<ticket>:<entrantId>\n` in ticket order (`lotteryListHash`, shared-core); `algorithm` `hmac-sha256-fisher-yates-v1` (F-707-l) | the verify page recomputes it from what is published |
| 6. No KEK loaded, or any write refused: the whole lottery rolls back, stays open, counts `failed`, is tried next minute | never a frozen list with no seed |

## The draw (F-707-l) — built

`engagement/lottery-draw.service.ts`, by the same `close-due` call right after
the freezes; the algorithm is `shared-core/src/lib/engagement/lottery-draw.ts`,
Web Crypto only, so the verify page (F-707-n) runs the same file (site-pwa keeps a byte-identical copy, held by its spec).

| Rule | Why |
|---|---|
| 1. One transaction per `frozen` lottery, locked `FOR UPDATE`; a failed one stays `frozen` and is drawn next minute | a crash between freeze and draw loses nothing: the seed is already sealed |
| 2. The tickets are read back and must hash to `listHash` with `entrantCount` tickets; else refused, never drawn | a list changed after the seed existed is not drawn over |
| 3. `hmac-sha256-fisher-yates-v1`: words from HMAC-SHA256(seed, `<listHash>:<i>`), i = 0, 1, …; `below(m)` by rejection sampling; Fisher–Yates over tickets 1..n, stopped after k places | uniform, and redone from what is published |
| 4. Places 1..W to the prizes in rank order, `winnersCount` each; the next `reservesCount` are reserves (`prizeId` null). Fewer tickets: the last prizes and reserves go unfilled | the higher prize is drawn first |
| 5. Winners written, then `drawnAt` = `publishedAt` = now, then `drawn` — together or not at all | seed, list hash and result public at once (point 5); the seed is read through its seal once `publishedAt` is set |
| 6. Once: `drawnAt` set once (`lottery_draw_is_history`), `frozen → drawn` one way; no route draws but `close-due` | no re-roll |

## The delivery and the result (F-707-m) — built

`engagement/lottery-delivery.service.ts`, by `close-due` right after the
draws; `lottery-result.service.ts` behind `GET …/lotteries/:id/result`.

| Rule | Why |
|---|---|
| 1. One transaction per `drawn` lottery with a pending prize, locked `FOR UPDATE`; places taken in place order | a reserve's turn is decided by the draw, never by timing |
| 2. Account deleted or not active → `passed_on`, `inactive`; a GB or days prize with no active Grant to take it → `passed_on`, `no_active_grant`, at once (user, 2026-10-03) | never queued for a purchase (point 2, F-707-b rule 3) |
| 3. A pass hands the prize to the first unused reserve, which names the place it replaces and is judged the same; none left: unawarded, the pass says so | every pass is on the record |
| 4. The tenant's refusal (template gone, variant, funds, limits) → stays `pending`, retried next minute | a reserve would be refused the same |
| 5. Given via `issueReward` (`source: lottery`, reference the place, actor the lottery's creator) in a savepoint; `delivered`, then `engagement.lottery.won` | once per place (F-707-b rule 6); a refusal undoes the issuer's writes |
| 6. The result is shown to whom the lottery is (F-707-j rule 4), only once `drawn` and `publishedAt` is set; the seed is opened from its seal; tickets carry entrant ids, never user ids | anyone in it can redo the draw (F-707-n) |

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
