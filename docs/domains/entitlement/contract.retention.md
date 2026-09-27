---
id: entitlement
layer: domain
status: draft
version: 12
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
| Only `active`, prepaid, not unlimited, and a period that opened with bytes to spend | an unlimited Grant has no bag; a metered one's volume is its wallet ("Wallet low") |
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

**Wallet low (F-601-g, spec 9.3 `wallet.low_balance`)** — a metered
Grant's volume left is what its wallet buys (network `contract.reserve.md`), so
it is told when the balance buys under **1 GB at its own rate**
(`LOW_BALANCE_BYTES`, the platform default decided in the row). Seen by
billing's block request after each purchase, in its transaction, from the
debit's `balanceAfter` (`traffic/low-balance.ts`, proved by
`low-balance.spec.ts`; billing `contract.traffic-block.md` rule 5).

| Rule | Why |
|---|---|
| Under the threshold and `lowBalanceNoticeAt` null: the write that sets it emits `entitlement.grant.low_balance`, `period` its instant, `remaining` what the balance buys | once per crossing; a racing purchase finds it set and emits nothing |
| A purchase whose balance buys ≥ 1 GB clears it | a top-up re-arms the next crossing, seen by the next block, not by the top-up |
| The whole balance at each Grant's rate, not its reserve share | two Grants at two rates cross at two balances; each is told its own |
| Nothing when the balance buys no byte, or no block was bought | a wallet that cannot buy the next block is the cutoff notice (`wallet_spent`), never this |
| A balance lowered elsewhere (a product paid from the wallet) is seen by the Grant's next block | the moment that matters is while it is served; an idle Grant spends nothing |

**Idle check-in (F-601-l, beyond the catalog)** — an active Grant that was
used, then consumed nothing for 7 days, is asked "trouble connecting?" once per
idle stretch. `entitlement/idle-notice.ts`, proved by `idle-notice.spec.ts`.
The clock is `idleCheckAt`: every charge that consumes a byte sets it to its
own instant + 7 days (`idleCheckOf`, shared-core; billing `contract.metering.md`).
`GrantIdleNoticeService.noticeDue` checks each active Grant whose clock is due,
over `POST /api/internal/billing/entitlement/idle-due` (`ServiceOnlyGuard`),
asked hourly by `grant_idle_notice`; answer `scanned`, `told`.

| Rule | Why |
|---|---|
| The check clears the clock, told or not; only the next consumed byte sets it again | one ask per stretch — a month idle hears once, a Grant used again can hear again a week later |
| A Grant never used has no clock | "not connected yet?" (F-601-c) is that Grant's |
| Told only if it can run: not past its end (`runs`), no standing close (`standingClose`), a prepaid bag not spent, a config confirmed on a panel; otherwise the stretch passes untold | idle because it stopped is the cutoff notice's (F-601-b), and with no config there is nothing to connect to |
| Metering sets the clock from processing time, not the delta's `observedAt` | a hold released late never moves the clock back |
| The write is conditional on the clock read; `period` = that clock; `supportUrl` when branding has one | a charge or a second sweep in between emits nothing; notification's ledger holds each stretch once (invariant 14) |

**Exhaustion forecast (F-602, spec 9.5)** — "at this rate, your volume runs
out in N days": a prepaid Grant whose last 72 h spend what is left of its
usage period within 5 days is told once per period (window, horizon and
independence from the usage levels: user, 2026-09-27).
`entitlement/exhaustion-forecast.ts`, proved by `exhaustion-forecast.spec.ts`.
`GrantExhaustionForecastService.noticeDue` checks each active prepaid Grant
used in the last 72 h (`idleCheckAt` past now + 4 days, F-601-l's clock) and
not yet told this period, over `POST /api/internal/billing/entitlement/forecast-due`
(`ServiceOnlyGuard`), asked hourly by `grant_exhaustion_forecast`; answer
`scanned`, `told`.

| Rule | Why |
|---|---|
| The rate is the Grant's configs' `traffic_raw_log` over the last 72 h (retired configs too), divided by the part of the window after `activatedAt ?? startsAt`; under 24 h of it says nothing | recent usage, not the period's average — and one busy hour is not a habit |
| Told when the bytes left last ≤ 5 days at that rate, and run out **before** `endsAt`; the days rounded up; 1 is `.runs_out_within_a_day`, else `.runs_out_soon` with `days` | a Grant that ends first hears its time notice (F-601-e), never a false "your volume runs out" |
| Only a bag below 95 % of its period and not spent: never unlimited, metered, past 95 % or spent | 95 % is the urgent notice; a metered volume is its wallet's ("Wallet low"); a spent bag is the cutoff |
| Its own notice: not held, not combined (F-601-n); kind `usage` for a mute (F-601-m) | a rate is a different fact from a level |
| `forecastNoticeFor` = the period told for (`usagePeriodStartedAt ?? startsAt`); the write is conditional on it and the period read; `period` = that period. A forecast not due writes nothing | once per period; a renewal that adds bytes opens one that can be told again; the next hour asks again |

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
| No grace period: a Grant stops at its end, volume or wallet at once; the warning is the 1-day notice ("Time thresholds") | bytes past the end are traffic nobody bought (F-603 dropped, user 2026-09-27) |

**Before purge (F-601-j, beyond the catalog)** — a suspended Grant is told,
a day before `purgeAfterDays` drops its configs from the panel ([contract.md](contract.md)
"Purge and restore"), what keeps them. `entitlement/purge-notice.ts`, proved by
`purge-notice.spec.ts`; swept by the purge's own hourly call, **after** the
purge (`purge-due` answers `told` beside its counts).

| Rule | Why |
|---|---|
| Due at `suspendedAt + (window - 1) days`, the window resolved as the purge resolves it, live; `0` is never scanned | purge off is never told; a 1-day window is told at the suspension |
| Only while a config is still `present` | a Grant the purge got to first is not told "within a day" |
| The clock is `purgeNoticeFor`, the `suspendedAt` told for; the write is conditional on the value read; `period` = `suspendedAt` | once per suspension; a revival clears `suspendedAt`, so the next one is due again with nothing reset |
| Prepaid: `entitlement.grant.purge_soon` ("renew"); metered: `.purge_soon_metered` ("top up") | a metered renewal adds days alone and revives nothing (as "Cutoff") |
| Never muted, never held for quiet hours (F-601-m) | the last chance to keep a config as it is |


**Active again (F-601-k, beyond the catalog)** — the answer to a cutoff: a
stopped Grant that runs again is told so, in the transaction that brought it
back. `entitlement/reactivated.ts` (`emitReactivated`), called by `renewGrant`
and `reviveFundedGrants`; proved by `reactivated.spec.ts`. Payload `tenantId,
userId, grantId, period`; template `serviceReactivated`.

| Rule | Why |
|---|---|
| A suspension revived (`reviveOnTopUp`) by a renewal or a wallet top-up: told, `period` = the `suspendedAt` it cleared | once per suspension; the revival's conditional write lets one racing caller through |
| An active Grant whose close stood as read (`standingClose`: the close's end is the Grant's, and its Quota for a bag; a bagless one's only on a passed end), renewed with room: told, `period` = the close's `closedAt` | an unlimited or metered Grant past its end is stopped though nothing suspends it; the planner reopens it on the moved end (`network/contract.lease.md` rule 25) |
| Nothing when the Grant still cannot run: its end, after the write, passed; a bag with no room (a carried debt); a metered close on its bag, which a renewal of days leaves closed | "active again" while it is off is the one false notice here |
| Nothing for a Grant that never stopped: active with no close, or a close on another end | there was no cutoff to answer |
| Told at the write, not at the panel: the text says it reconnects within minutes, the link unchanged | the convergence loop and the planner re-enable the configs after the commit |
