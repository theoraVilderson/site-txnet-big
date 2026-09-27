---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-27
---

# The hot loop — the few configs near their ceiling, in seconds

A topic file of `contract.md` (§10). What governs `collect.Poller` (F-027-de),
which replaced `network-service/internal/hot`, and `billing-service/src/app/traffic/horizon.ts` (F-027-u, ADR-0072) with its
callers `traffic/hot-loop.consumer.ts` (F-027-cl, ADR-0092) and
`traffic/hot-loop.sweep.ts` (F-027-cn): when a
config is read sooner than the bulk pass reads it, and how much traffic is
bought next. Read it before changing an interval, a horizon or a block size.

**Everything here is sized in seconds, never in bytes.** Six gigabytes of
headroom is fifty-one seconds on a gigabit line and thirteen hours on a megabit
one, and no byte figure is right for both. A bulk pass is a minute
(`contract.collection.md`), so a gigabit user can cross their ceiling and keep
going for most of an interval before anything reads the counter that says so.
Buying a bigger block is not the answer — that holds more of a wallet ahead of
consumption, which is ADR-0072's accepted cost and its revisit trigger. Reading
sooner, and buying for a fixed number of seconds rather than a fixed number of
bytes, is.

## Time to ceiling is the only figure

```
time to ceiling = headroom / rate
```

Headroom is what is left of the allowance — a config's `allocatedCeilingBytes`
less its lifetime bytes on the collector's side, a Grant's `purchasedBytes`
less its `consumedBytes` on the money side. Membership, the interval and the
horizon are all this one number, which is why the two halves agree without
sharing a line of code.

Three readings of it are fixed, and each is a refusal to guess:

| | |
|---|---|
| **no headroom** | zero, at any speed. A spent allowance is hot even on a panel nothing has ever measured |
| **no rate at all** | *unknown*, not *about to run out*. Never measured, on a panel declaring no `maxLineRateBps` — zero there means unknown, the same reading the plausibility cap gives the column. The bulk pass keeps it and nothing is bought |
| **never measured, line rate known** | judged at the panel's line rate. Until a pass has measured this config, the safe assumption is that it is at line speed |

## The collector's half — the planned poll (F-027-de)

**Since F-027-de nothing runs `internal/hot`.** Its one interval for every
panel — the nearest time to ceiling, quartered, clamped to `[2s, 60s]` — is
replaced by the lease planner's own schedule, per panel (SPEC §5, §6-6,
weaknesses #11, #12). The package stays until F-027-dk retires it.

`collect.Poller` sweeps every 250 ms and reads a panel when
`leaseplan.Planner.NextPoll` says it is due. A poll is **the bulk pass's own
turn** — one whole-panel read, publish, cursor move, plan, converge — so the
planner sees every counter it bills from, and its tick clock learns from reads
less than a tick apart, which a minute's pass never is.

1. **When is the planner's figure.** Each plan's `PollBy` hint per panel
   (active: a third of the seconds its hold lasts, idle: half the seconds at
   `BurstRate`, a write in flight: `WriteLatency` + 1 s, endgame: a third of
   `tEnd`). A panel's read drops its old hints; the earliest since is kept.
2. **Then aligned**: `PollGuard` (1 s) after the panel's tick
   (`TickClock.AlignPoll`) — a read between two ticks sees nothing new — and
   no sooner than `max(MinPoll, PollGap)` after the last read.
3. **`PollGap` is the panel's own budget**: polls spend at most half of
   `maxRequestsPerMinute`, two requests each (`GetUsage` + `ListClients`), so
   `4 min / maxRequestsPerMinute`. `Paced` still holds every request.
4. **A mid-tick probe every `ProbeEvery` (5 min)**: aligned polls cannot see a
   phase that moved, so one extra poll lands halfway into the tick after a
   read — inside J of it, or the pair teaches nothing. It skips `MinPoll`,
   never `PollGap`: a budget that cannot pay two reads in one tick is not
   probed. A read mid-tick, from any loop, counts as the probe.
5. **No hint is no poll**: the bulk pass is then the panel's only read. A
   failed poll waits `PollRetry` (15 s, SPEC §4); a panel another turn holds
   is skipped, and that turn's plan moves its next poll.
6. **The plausibility cap is floored at `PollMinWindow` (2 s)** on a poll,
   not the bulk minute, as the hot loop's was.

## The money half — the horizon and the block

**Since F-027-dc `horizon.ts` buys nothing.** The lease planner asks for a
metered block when the bag runs out inside its horizon, over
`network.lease.block_request`, and `traffic/block-request.ts` buys it
([contract.lease.md](contract.lease.md) rules 20–23). The delta stream's
guess here was a second buyer of one bag. Since F-027-db `rebalance` writes
nothing either. What still runs below is the rate measurement, the sizing
(reported, never spent), and exhaustion; F-027-dk retires the rest.

`sizeHorizon` still reports the target a hot Grant would be topped up to —
`HORIZON_SECONDS` (120) of its projected rate, less its headroom — and
`MIN_BLOCK_SECONDS` still floors a real purchase, now in the block request.

**A config is hot on its own share too** (F-027-cl). The panel cuts a config
off at its share, not at the bag, so a Grant far from spent can still have one
config seconds from its cut. When a config is inside `HORIZON_SECONDS` of its
`allocatedCeilingBytes` less its lifetime bytes, and the bag still holds
bytes, the pass re-splits (`rebalance`) with nothing bought. The concentrated
config is the fastest one. If nothing measurably runs, it is the one nearest
the end of its share, because a config the panel has cut measures no rate.

**The rate is measured, then extrapolated up but never down.** A rate still
climbing is extrapolated one more step of the same climb: a user who went from
10 Mbit to 100 between two samples is not a 100 Mbit user, and a block sized at
100 is spent before the interval that bought it is over. A **falling** rate is
taken at face value and no further — sizing below what is being measured right
now buys a block the user has already outrun.

The rates are measured from this loop's own samples, because the interval
between two of its passes is the only window a rate means anything over. What
is written back is `config.observedRateBps`, which is what the collector's half
reads and what the service page shows.

**No first block is guessed** (F-027-dc). A Grant with nothing measured is
leased from the reserve, which is part of the planner's Quota; the first pass
that measures a rate asks for the block, overrun included, so the line-rate
assumption that once sized a first block is no longer needed.

### The block floor, and why it is here

`MIN_BLOCK_SECONDS` (60) floors the **target**, never the horizon. Every block
is a `traffic_consumption` row in the wallet ledger, and without a floor a
Grant hovering a second inside the horizon buys one second of traffic on every
pass, for as long as the user stays hot. Flooring the target bounds that at one
row a minute per Grant at any line speed — a faster user's minute is a bigger
block, not a more frequent one.

It is in `traffic/block-request.ts`, over the rate the planner measured, and
not in `BlockPurchaseService`. `purchase()` never clamps a target **up**:
spending more of a wallet than was asked for is the caller's decision
(F-027-am, decided with the user 2026-09-22).

## When the bag is spent and nothing can be bought (F-027-x)

A pass that finds `purchasedBytes - consumedBytes ≤ 0` asks
`suspendIfExhausted` (`traffic/exhaustion.ts`), in the same transaction — as
does a block request the wallet refused on a spent bag. A wallet that can
still buy answers `wallet_can_buy`: the planner leases the reserve and its
request buys the block.

It locks the wallet row, re-reads the cursors, and suspends only if the bag is
spent **and** no block is affordable — entitlement's `suspendForExhaustion`,
which is `suspended` with `statusReason = quota_exhausted`, never `exhausted`
(ADR-0075). The lock is what keeps a top-up from being undone: it either
committed first and is seen, or it waits and finds the Grant suspended.

**An unlimited Grant never gets here** (F-111-q). Its bag is 0, so it would be
inside the horizon every pass and spent from the first byte: `topUpIn` answers
it at once — not hot, nothing bought, `exhausted: null` — and
`suspendIfExhausted` answers `unlimited` before reading the wallet's figure.
Its usage is still counted: the delta consumer advances `consumedBytes` for
every Grant alike.

## The channel between the halves — the delta stream (F-027-cl, ADR-0092)

`billing-service` has its own durable queue (`HOT_LOOP_QUEUE`) on
`network.usage.#`, beside `metering-service`'s. Each collection pass, bulk or
hot, becomes **one `topUp` per Grant** the pass carried a delta for, under that
Grant's tenant (the config read that finds it is cross-tenant, as metering's
is). There is never one per delta: two configs of one Grant would buy two
blocks for one horizon. Because the collector reads a hot config every 2–60 s
and publishes each read, the calls arrive at the rate the hot few need.

- **Prefetch 1, fixed.** Rates are measured between two of this process's
  passes, in memory. Two passes handled at once would measure each other's
  gap.
- **One behind metering, at most.** The bytes that woke a top-up may not be
  applied to `consumedBytes` or the cursors yet. The top-up sizes from rows,
  never from the message, so headroom is overstated by one pass at most. That
  is the quarter-interval's premise above.
- **A lost race is not a failure.** `WalletVersionConflict` means another
  pass bought first. Any other failure is raised after the pass's other
  Grants are done, and the pass dead-letters as evidence. Nothing is owed by
  it, because the next pass re-reads the same rows.
- **An idle Grant is not called by the stream.** A zero delta is not
  published, so a config the panel cut off at its share, beside configs that
  are idle, is never named by a pass.

**The sweep is the second caller** (F-027-cn, ADR-0092 amendment). Every
minute `worker-service`'s `hot_loop_sweep` asks billing
`hot-loop/sweep-due` (`traffic/hot-loop.sweep.ts`). It names each `active`,
not unlimited Grant with `purchasedBytes > consumedBytes` and an active,
enabled config whose cursor lifetime (up + down) is at or past its
`allocatedCeilingBytes`, and runs the same `topUp` on it in its tenant. The
split moves onto the cut-off config, and the convergence pass raises its
ceiling and re-enables the client. Once split, the config's share is above what
it served, so the next scan skips it (ADR-0027: safe twice). It runs beside
the consumer in the same process, so a sweep may add a rate sample between
two passes; an idle Grant measures zero either way.

## Running it — `cmd/server` (F-027-bu, F-027-de)

`cmd` starts `collect.Poller` beside the bulk pass, over the pass's offered
panels (`PostgresSource.Offered`) and its planner; `hot.Loop` is no longer
started. A poll holds the panel's turn (`collect.TurnLocks`) like any turn,
and one finding it held steps aside — the holder's read covers it.

## What it will not do

A poll writes to a panel only through the turn's convergence step (F-027-t),
and decides no share — that is the lease planner's (F-027-db). The per-panel
request budget it runs under, and the ban it refuses to retry through, are
[contract.budget.md](contract.budget.md) (F-027-v) — built with this loop
rather than after it, because an unbudgeted hot loop is a denial of service on
a customer's own server. Extending a ceiling on shutdown is
[contract.resilience.md](contract.resilience.md) (F-027-w). A panel halted by a
drift event is not read here either, and a hot subset is contained by the bulk
pass's thresholds before it publishes (F-027-ab, `contract.drift.md`).
