---
id: entitlement
layer: domain
status: draft
version: 16
updated: 2026-09-28
---

# Contract — entitlement: an admin's actions on a Grant

A §10 split of [contract.md](contract.md), which is at its ceiling. What a
reseller's admin does to one of its users' Grants by hand (F-311). Each runs in
the caller's transaction; the HTTP routes, their door and status codes are
billing's [contract.reseller-grants.md](../billing/contract.reseller-grants.md).

**Freeze (F-311-h)** — `freezeGrant(tx, id, {at, until?})` and
`unfreezeGrant(tx, id, at)` in `entitlement/freeze.ts`, proved by `freeze.spec.ts`.
A freeze moves an `active` Grant to `suspended`, `statusReason = admin_frozen`
(`ADMIN_FROZEN`), `suspendedAt = at`, every config `desiredEnabled = false`.
**Kept** (user, 2026-09-27): the purge and its day-ahead notice skip it, so an
unfreeze turns on the lines the user already holds. **The clock stops**: unfreeze
moves `endsAt` by `at - suspendedAt` (permanent stays permanent) and restores
configs as `reviveOnTopUp` does. `until` (`frozenUntil`) ends it by itself: the
hourly `purge-due` tick unfreezes each due one first (`GrantUnfreezeService`,
answer `unfrozen`). Refused: `grant_not_active` (a quota stop stays the top-up's),
`grant_not_frozen`, `freeze_until_not_future`, `grant_moved` (the end moved: retry).
A top-up or renewal never lifts it (both key on `quota_exhausted`). Its HTTP
route is billing's `contract.reseller-grants.md` (F-311-h).

**Days (F-311-i)** — `changeGrantDuration(tx, id, {at, actorUserId, change, reason})`
in `entitlement/duration.ts`, proved by `duration.spec.ts`. `change` is `{days}`
(±N from the end it **has**, not from now) or `{endsAt}`; an `active` or
`suspended` Grant moves, its reason untouched. Each move writes one
`grant_duration_change` row (actor, `endsAtBefore`, `endsAtAfter`, reason) —
duration is `endsAt`, not a quota metric (§4.5). Refused: `grant_closed`
(expired / exhausted / cancelled: a renewal's, F-311-d), `grant_not_active`
(pending), `grant_permanent`, `duration_unchanged`, `duration_end_not_future`
(cutting off is a delete, F-311-m), `grant_moved`. Route: billing `contract.reseller-grants.md`.

**Traffic (F-311-j)** — `adjustGrantTraffic(tx, id, {at, actorUserId, deltaBytes, reason})`
in `entitlement/traffic.ts`, proved by `traffic.spec.ts`. Quota is `purchasedBytes`,
which the lease planner reads every pass (network `contract.lease.md` rule 1), so
the column moves by ±`deltaBytes` **and** one `quota_adjustment` row (`traffic_bytes`,
source `admin_grant`, `createdByAdminId`, reason) is written (invariant 3) — the row
alone moves no ceiling; the planner reallocates on its next pass. An `active` or
`suspended` prepaid Grant moves, frozen ones included. **A cut below Used is written,
not refused** (`spent: true`), and not suspended here: the planner's close is the one
rule for "spent" (ADR-0096) — it closes on the new Quota and `suspendIfClosed`
suspends it as exhausted. A raise that leaves room revives a Grant suspended for
quota (`reviveOnTopUp`; a frozen one stays frozen) and is told (F-601-k), as a renewal.
Unlike a renewal it forgives no debt and opens no usage period: the admin's figure is
the change, whole. Used is `usedBytesOf` (`renewal.ts`), the renewal's own sum.
Refused: `grant_closed`, `grant_not_active` (pending), `traffic_not_adjustable`
(metered — its blocks buy its bytes — or unlimited), `quota_below_zero`, `grant_moved`
(Quota changed since the read: retry). `adjustQuota` stays the bare row writer.

**Reset (F-311-k)** — `resetGrantTraffic(tx, id, {at, actorUserId, reason})` in
`entitlement/traffic.ts`, proved by `traffic-reset.spec.ts`. The full bag is left
again **without touching the meter** (user, 2026-09-26): `consumedBytes` and the
lifetime counters are usage history and billing evidence, so Quota rises instead —
by `resetBytes` = Used − `trafficResetFromBytes` (Used at the last reset, 0 = never),
and the cursor moves to Used. So Quota − Used after any number of resets is the bag
before the first; a second reset never re-adds the first's bytes. One `admin_grant`
row, as Traffic. It opens a usage period (`usagePeriodFromBytes = consumedBytes`, as
a renewal's bytes do, F-601-d), so the usage levels are told again, and revives and
is told as a raise (a frozen Grant stays frozen). Refused as Traffic, plus
`nothing_to_reset` (nothing used since the last reset); `grant_moved` also on a
moved cursor, so two resets racing add once. Route: billing `contract.reseller-grants.md`.
