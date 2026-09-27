---
id: entitlement
layer: domain
status: draft
version: 10
updated: 2026-09-27
---

# Contract — entitlement: retention notices

A §10 split of [contract.md](contract.md), which is at its ceiling. The
moments this unit tells a Grant's owner about (F-601, spec 9.5): it only
emits (spec 9.2); `worker-service` tells, once per period by notification's
ledger ([notification/contract.retention.md](../notification/contract.retention.md)).
The events' payloads are in [contract.md](contract.md) "Emits".

**"Not connected yet?" (F-601-c, spec 9.5)** — `entitlement/unused-notice.ts`,
proved by `unused-notice.spec.ts`. Activation writes `activatedAt` and starts
`unusedCheckAt` 24 h later: `markDelivered` for a purchase, `issue` (at
`startsAt`) for a Grant born `active`; never for `migration` or `rollover`
(`unused-clock.ts`). `GrantUnusedNoticeService.noticeDue` checks each active
Grant whose clock is due, over `POST /api/internal/billing/entitlement/unused-due`
(`ServiceOnlyGuard`), asked hourly by `grant_unused_notice`; answer `scanned`, `told`.

| Rule | Why |
|---|---|
| Any consumed byte clears the clock, untold | a user who connected is not asked |
| At 24 h: `entitlement.grant.not_connected`, next check at 72 h; at 72 h: `.still_not_connected`, clock cleared. A sweep late past 72 h tells only the second | two asks, then silence |
| No live config confirmed on a panel (`confirmedAt`): the stage passes untold | nothing to connect to yet — F-601-i's notice, not this one |
| The clock moves conditionally on the value read; the event's `period` is `activatedAt` | two racing sweeps emit once; notification's ledger holds it past that (invariant 14) |
| `supportUrl` from the tenant's branding, only when set | the notice's support line (auth-api `/internal/notify/user`) |

**Usage thresholds (F-601-d, spec 9.5)** — a prepaid Grant told at 50, 80
and 95 % of its **usage period's** bytes. The period opens at issue and again at
each renewal that adds bytes (`renewGrant` writes `usagePeriodFromBytes` =
`consumedBytes` and `usagePeriodStartedAt`; days alone open none), and the share
is `(consumedBytes - from) / (purchasedBytes - from)` — never of the cumulative
Quota, which a renewal at 96 % would read as 48 %. The crossing is seen by the
charge that makes it: billing's `MeteringService.charge`, in its transaction
(`usage-threshold.ts`, billing `contract.metering.md`), emits the level's event.

| Rule | Why |
|---|---|
| One charge past two levels tells the higher alone; none once `consumedBytes ≥ purchasedBytes`. 50 / 80 % are held, 95 % is not ("The 24 h hold") | the user hears the latest truth; a spent bag is the cutoff notice (F-601-b) |
| Only `active`, prepaid, not unlimited, and a period that opened with bytes to spend | an unlimited Grant has no bag; a metered one is F-601-g |
| `period` = `usagePeriodStartedAt ?? startsAt`; one type per level | notification's ledger lets each level through once per period (invariant 14) |

**Time thresholds (F-601-e, spec 9.5)** — `entitlement/end-notice.ts`, proved
by `end-notice.spec.ts`. An active Grant is told 7, 3 and 1 day(s) before its
`endsAt`: unlimited and metered alike, only a permanent one (`endsAt = null`)
never. `GrantEndNoticeService.noticeDue` checks each active Grant ending
within 7 days whose clock is due or was set for another end, over `POST
/api/internal/billing/entitlement/end-due` (`ServiceOnlyGuard`), asked hourly
by `grant_end_notice`; answer `scanned`, `told`.

| Rule | Why |
|---|---|
| The clock is `endNoticeFor` (the end it was set for) + `endNoticeAt` (that end's next level). An end that no longer matches `endNoticeFor` starts over from its own levels | a renewal moves `endsAt` and is due again by itself — no writer of `endsAt` resets anything |
| A sweep late past two levels tells the lower alone; the `days` param is the whole days actually left | the latest truth, once — a Grant renewed to 4 days left hears "4 days", never "7" |
| A level that fell due before `activatedAt ?? startsAt` passes untold | a 5-day service is not "ending soon" the minute it is bought |
| 7 and 3 days: `serviceEndsSoon`; 1 day: `serviceEndsWithinADay` | a day's notice is the last one, and "1 days" is not a sentence |
| The write is conditional on the end and the clock read; `period` = `endsAt`, one type per level | two sweeps, or a renewal between read and write, emit once; notification's ledger holds each level once per end (invariant 14) |

**The 24 h hold (F-601-n, user 2026-09-27)** — a usage and a time level
due the same day reach the user as one message, and none is told early. The
rules are shared-core `retention-levels.ts` (`retentionToTell`, proved by
`retention-levels.spec.ts`), applied by metering at the crossing and by
`GrantEndNoticeService.check` hourly (`end-notice.spec.ts`).

| Rule | Why |
|---|---|
| 50 / 80 % and 7 / 3 days wait up to 24 h from when they fell due; both kinds due is one event, now — the usage type carrying the time level | the user hears them together, and neither is told before its moment |
| 95 % and the last day are never held, and take a held one of the other kind with them | an urgent notice is never delayed |
| A held usage level lives on the Grant (`usageNoticeLevel`, `usageNoticeSince`); a higher level replaces it and keeps its start. A held time level is the clock left unmoved, due again next hour | the hold survives restarts; the sweep drains both |
| Told late, the words are as of the telling: the days left from `endsAt`, the volume left from the Grant | a notice held a day says "6 days", never a stale "7" |
| A held usage level of a closed period (a renewal that added bytes), or of a spent bag, is dropped untold | it is no longer true — the spent bag has its cutoff notice |
| The sweep asks two questions, each its own batch of 500: Grants ending within 7 days whose clock is due, and held usage levels 24 h old; every write is conditional on the clock and held level read | a charge, a renewal or a second sweep between read and write emits nothing twice |

**Cutoff (F-601-b, spec 9.5)** — the user is told their service stopped,
and what brings it back. Emitted by billing's `traffic/exhaustion.ts` through
`emitCutOff` (`entitlement/cut-off.ts`), in the transaction that saw the stop;
proved by `cut-off.spec.ts`. Payload `tenantId, userId, grantId, period`.

| Rule | Why |
|---|---|
| `suspendIfClosed` suspending a prepaid Grant: `ended` when the close was on its end, else `volume_spent`; both say "renew" | a renewal moves the end or raises Quota, and revives it |
| `suspendIfExhausted` suspending a metered Grant: `wallet_spent`, which says "top up" | a top-up revives it (`reviveFundedGrants`); a metered renewal adds days alone and revives nothing |
| An unlimited or metered Grant whose standing close is on a passed end: `ended`, and nothing written to the Grant | it has stopped though nothing here suspends it — the one way an unlimited Grant stops |
| A close stands only while its Quota **and** end are the Grant's (`network/contract.lease.md` rule 25); one a renewal moved is `reopened`, untold | a late close never suspends, nor tells, a renewed Grant |
| `period` = the end for `ended`, the suspension's instant otherwise; nothing is emitted when nothing stopped (a redelivered close finds it `suspended`) | notification's ledger holds each stop once (invariant 14); a renewal or revival opens a new one |
| Never muted, never held for quiet hours (F-601-m) | a user whose service stopped must hear it |
