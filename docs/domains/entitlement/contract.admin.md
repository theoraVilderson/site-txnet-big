---
id: entitlement
layer: domain
status: draft
version: 20
updated: 2026-09-28
---

# Contract — entitlement: an admin's actions on a Grant

A §10 split of [contract.md](contract.md), which is at its ceiling. What a
reseller's admin does to one of its users' Grants by hand (F-311), renewal included. Each runs in
the caller's transaction; the HTTP routes, their door and status codes are
billing's [contract.reseller-grants.md](../billing/contract.reseller-grants.md).
Every act here, and each config act, is told to the user once, beside its audit
row (F-311-s, audit `contract.md` "Emits"). One that also brings a stopped Grant
back reports `reactivated` and writes no "active again" of its own: the admin's
notice says it, in the same message.

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
**A lapsed Grant's days revive it (F-311-z):** `suspended` as `period_ended`, its end
moved ahead is a renewal of days (`reviveOnRenewal`, told inside the days notice, F-311-s; a spent bag →
`quota_exhausted`, purge clock running), so it is never purged with days left. `revived`.

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
quota (`reviveOnTopUp`; a frozen one stays frozen), told inside the traffic notice (F-311-s).
Unlike a renewal it forgives no debt and opens no usage period: the admin's figure is
the change, whole. Used is `usedBytesOf` (`renewal.ts`), the renewal's own sum.
Refused: `grant_closed`, `grant_not_active` (pending), `traffic_not_adjustable`
(metered — its blocks buy its bytes — or unlimited), `quota_below_zero`, `grant_moved`
(Quota changed since the read: retry). `adjustQuota` stays the bare row writer.
A metered Grant's bag takes an admin's **gift** instead (billing F-311-l,
`contract.traffic-block.md`): source `admin_gift`, never on a Grant's own `source`.

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

**Delete (F-311-m)** — `deleteGrant(tx, id, {at, actorUserId, reason, refund}, settle)`
in `entitlement/delete.ts`, proved by `delete.spec.ts`. An `active` or `suspended`
Grant (frozen or out of quota) becomes `cancelled`, `statusReason = admin_deleted`
(`ADMIN_DELETED`), `frozenUntil` cleared, and every config still `present` gets
`desiredRemote = absent`, `desiredEnabled = false` **now** — the purge's write
without `purgeAfterDays`. No row is deleted (invariant 13); `cancelled` is terminal,
so a user who should have it back is issued a new Grant. **The remainder is the
admin's answer** (user, 2026-09-26): `refund` runs billing's
`RemainderCreditService.settle` after the cancel, in the same transaction — a
metered bag by F-027-r, a prepaid Grant by the larger share of volume or time
used (user, 2026-09-28; `contract.traffic-block.md`), its clock stopped at
`suspendedAt` if it was frozen; without `refund` (fraud) no money moves. A
refund that finds nothing still deletes and says why — `refundSkipped`:
`nothing_paid`, `nothing_to_credit`, `not_measurable`, `rate_not_priceable`,
`grant_not_metered` (metered, no locked rate).
One `grant_deletion` row keeps the choice, reason, status before and what was
credited (invariant 25). Refused: `grant_closed`, `grant_not_active` (pending:
the delivery's, invariant 14), `grant_moved` (the status moved, or a block was
bought before the credit — all rolled back). Route: billing `contract.reseller-grants.md`.

**Issue (F-311-o)** — `issueGrantByAdmin(tx, grants, {userId, variantId, requestId, actorUserId, at})`
in `entitlement/admin-issue.ts`, proved by `admin-issue.spec.ts`. `GrantService.issue`
with `source = admin_grant`, `sourceReferenceId = requestId`, `issuedByAdminId` the
admin: no invoice, `active` at once, `admin_only` variants included (F-506). **Placed
like a purchase** — group fulfilment's sweep writes its configs, so what invoice
create refuses to sell is refused before a Grant exists: `variant_not_deliverable`
(no handler for the kind, no placeable group, a prepaid network variant stating no
traffic). **One request, one Grant**: a repeat of `requestId` answers that Grant
(`issued: false`); the same id for another user or variant is `request_reused`.
Also refused: `variant_not_found`, `variant_not_assignable` (switched off),
`metered_rate_missing` / `metered_rate_not_positive`, `already_issued` (a concurrent
repeat: retry). Route: billing `contract.reseller-grants.md`.

**Devices (F-311-q)** — `setGrantDeviceLimit(tx, id, {limit, reason, actorUserId, at})`
in `entitlement/devices.ts`, proved by `devices.spec.ts`. The limit is the Grant's own
`quotas.concurrent_devices.limit` — the entry a variant's sold limit is copied into, the
entry's other fields and the other metrics left as they were; `null` removes the entry.
One `quota_adjustment` row (`concurrent_devices`, delta after − before with none as 0,
`admin_grant`, the admin, the reason — invariant 3), conditional on the quotas read. An
`active` or `suspended` Grant, frozen included. **Never refused by a panel** (user,
2026-09-28): the answer's `panelsNotEnforcing` names each live config's panel that does
not answer `per_client_ip_limit` yes; network writes it where one does (`contract.provisioning.md`
"Device limit"). Refused: `grant_closed`, `grant_not_active`, `devices_unchanged`, `grant_moved`.

**Renew (F-311-d)** — `renewGrantByAdmin(tx, {grantId, requestId, actorUserId, at, reason, amount?})`
in `entitlement/admin-renewal.ts`, proved by `admin-renewal.spec.ts`. `renewGrant`
([contract.md](contract.md) "Renewal") on the same Grant, `source = admin_grant`, the
admin on each adjustment row — **no invoice, no money** (user, 2026-09-28: the reseller
collects outside the platform; a renewal from the wallet is the user's own, F-305).
**Without `amount` it is one period of the plan the user bought**: the Grant's own bag
(`quotas.traffic_bytes`) and `periodDays`, both copied at issue — never the variant as
edited since. A metered or unlimited Grant's period is its days alone; a permanent one's
its bytes alone. **With `amount` (`{bytes, days}`) it is what the admin typed.** Debt
forgiven, usage period, revival of a lapsed Grant (F-027-do) and the refusals
(`grant_not_renewable`, `traffic_not_renewable`, `nothing_to_renew`, `grant_moved`) are
`renewGrant`'s. **One request, one renewal**: one `grant_renewal` row per `requestId`
(unique) — actor, plan or typed, bytes, days, forgiven, Quota and end before and after,
optional reason (invariant 27); a repeat answers it (`renewed: false`). Also refused:
`plan_period_unknown` (a dated Grant issued without a variant: type the amount),
`request_reused` (the id on another Grant), `already_renewed` (a concurrent repeat:
retry). Route: billing `contract.reseller-grants.md`.
