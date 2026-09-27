---
id: network
layer: domain
status: draft
version: 18
updated: 2026-09-27
---

# The planned poll — a panel read when its plan says, and the block it asks for

A topic file of `contract.md` (§10). What governs `collect.Poller` (F-027-de):
when a panel is read sooner than the bulk pass reads it, and what happens when
a metered Grant's bag runs out. Read it before changing a poll interval, a
horizon or a block size.

**Since F-027-dk the hot loop is gone.** `network-service/internal/hot`,
billing's `traffic/horizon.ts` (F-027-u), its delta-stream caller
`traffic/hot-loop.consumer.ts` (F-027-cl, ADR-0092) and the minute sweep
`traffic/hot-loop.sweep.ts` with worker-service's `hot_loop_sweep` job
(F-027-cn) were replaced by the lease planner (ADR-0093) and deleted. Their
jobs moved: *when to read* is the planner's `PollBy`, *how much to buy* its
block request, *the rate* the collector's own `config.observedRateBps`
(`collect.Rates`), and *who carries a share* the planner alone
([contract.ceiling.md](contract.ceiling.md)).

**Everything here is sized in seconds, never in bytes.** Six gigabytes of
headroom is fifty-one seconds on a gigabit line and thirteen hours on a megabit
one, and no byte figure is right for both. A bulk pass is a minute
(`contract.collection.md`), so a gigabit user can cross their ceiling and keep
going for most of an interval before anything reads the counter that says so.
Reading sooner, and buying for a fixed number of seconds rather than a fixed
number of bytes, is the answer; a bigger block holds more of a wallet ahead of
consumption, which is ADR-0072's accepted cost.

## The collector's half — the planned poll (F-027-de)

**Since F-027-de nothing runs `internal/hot`.** Its one interval for every
panel — the nearest time to ceiling, quartered, clamped to `[2s, 60s]` — is
replaced by the lease planner's own schedule, per panel (SPEC §5, §6-6,
weaknesses #11, #12). F-027-dk deleted the package.

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

## The money half — the block request (F-027-dc)

The lease planner asks for a metered block when the bag runs out inside its
horizon, over `network.lease.block_request`, and billing's
`traffic/block-request.ts` buys it ([contract.lease.md](contract.lease.md)
rules 20–23). It is the only path that buys a block. The request carries the
bag the planner saw, so two requests for one bag buy once.

`traffic/block-request.queue.ts` is billing's broker end: the durable queue
still named `HOT_LOOP_QUEUE`, at prefetch one, bound to the block request
alone. It **unbinds** `network.usage.#` at boot — the binding the hot loop's
consumer added lives on the broker — and acks unread any pass still queued
from before.

### The block floor

`MIN_BLOCK_SECONDS` (60, in `block-request.ts`) floors the **target**, over the
rate the request carries. Every block is a `traffic_consumption` row in the
wallet ledger, and without a floor a Grant hovering a second inside the horizon
buys one second of traffic on every request. Flooring the target bounds that
at one row a minute per Grant at any line speed. It is here and not in
`BlockPurchaseService`: `purchase()` never clamps a target **up** — spending
more of a wallet than was asked for is the caller's decision (F-027-am,
decided with the user 2026-09-22).

**No first block is guessed.** A Grant with nothing measured is leased from
the reserve, which is part of the planner's Quota; the first pass that
measures a rate asks for the block, overrun included.

## When the bag is spent and nothing can be bought (F-027-x)

A block request the wallet refused on a spent bag asks `suspendIfExhausted`
(`traffic/exhaustion.ts`), in the same transaction. The planner re-asks every
`BlockRetry` (30 s) while the bag stays inside its horizon, and a cut-off
config's overrun keeps a spent bag there, so a refused Grant is asked again
rather than forgotten. A bag at exactly zero with no rate is not asked for:
nothing is being served, and the panel already holds it at its share. A wallet that can
still buy answers `wallet_can_buy`: the planner leases the reserve and its
request buys the block.

It locks the wallet row, re-reads the cursors, and suspends only if the bag is
spent **and** no block is affordable — entitlement's `suspendForExhaustion`,
which is `suspended` with `statusReason = quota_exhausted`, never `exhausted`
(ADR-0075). The lock is what keeps a top-up from being undone: it either
committed first and is seen, or it waits and finds the Grant suspended.

**An unlimited Grant never gets here** (F-111-q). The planner never loads it, so no
block is asked for; `block-request.ts` answers one `not_metered` anyway, and
`suspendIfExhausted` answers `unlimited` before reading the wallet's figure.
Its usage is still counted: the delta consumer advances `consumedBytes` for
every Grant alike.

## Running it — `cmd/server` (F-027-bu, F-027-de)

`cmd` starts `collect.Poller` beside the bulk pass, over the pass's offered
panels (`PostgresSource.Offered`) and its planner. A poll holds the panel's
turn (`collect.TurnLocks`) like any turn, and one finding it held steps aside
— the holder's read covers it.

## What it will not do

A poll writes to a panel only through the turn's convergence step (F-027-t),
and decides no share — that is the lease planner's (F-027-db). The per-panel
request budget it runs under, and the ban it refuses to retry through, are
[contract.budget.md](contract.budget.md) (F-027-v). Extending a ceiling on
shutdown is [contract.resilience.md](contract.resilience.md) (F-027-w). A
panel halted by a drift event is not read here either (F-027-ab,
`contract.drift.md`).
