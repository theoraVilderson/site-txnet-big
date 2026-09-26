---
id: network
layer: domain
status: draft
version: 15
updated: 2026-09-26
---

# The hot loop — the few configs near their ceiling, in seconds

A topic file of `contract.md` (§10). What governs `network-service/internal/hot`
and `billing-service/src/app/traffic/horizon.ts` (F-027-u, ADR-0072) with its
caller `traffic/hot-loop.consumer.ts` (F-027-cl, ADR-0092): when a
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
| **never measured, line rate known** | judged at the panel's line rate. Until a pass has measured this config, the safe assumption is that it is at line speed — which is also the first block's size, below |

## The collector's half — membership and the interval

`internal/hot` re-reads the hot few on its own interval. A pass is **one
request per panel**: `GetUsageFor` takes the named subset, and a family with no
subset endpoint serves it from its bulk call (invariant 34, `contract.md`). It
publishes the same delta stream a bulk pass does, through the same normaliser,
sink and cursors — nothing downstream can tell the two apart, and the cursor
still moves only after the publish succeeds (invariant 18).

- **Membership** is `time to ceiling ≤ DefaultHorizon` (120s), re-read every
  pass. A user who starts a download joins on the next one and one who stops
  leaves on it; there is no list to keep in sync.
- **The interval** is the **nearest** time to ceiling in the set, quartered,
  clamped to `[2s, 60s]`. The nearest and not the average: the loop runs for
  whoever is closest to their ceiling, and the rest are read early rather than
  late. A quarter bounds how much of what a member has left can run unseen
  between two readings.
- **The clamp is two refusals.** Below two seconds the loop is a request rate
  on a machine we do not own (F-027-v), and the panel's own ceiling is already
  enforcing underneath it. Above sixty it is slower than the bulk pass it
  exists to beat, so `MaxInterval` *is* `collect.DefaultInterval` rather than a
  number that happens to match it.
- **Nobody hot is no request at all.** A pass that called every panel to learn
  that would be the bulk pass again at a fraction of its interval.
- **The plausibility cap is floored at the hot interval**, not the bulk one. A
  hot pass two seconds after the last must be capped over two seconds, or the
  cap it applies is thirty times looser than the traffic it is checking.

## The money half — the horizon and the block

`horizon.ts` sizes what to buy and calls `BlockPurchaseService.purchase` and
`CeilingAllocatorService.rebalance` **in one transaction**. There is no window
where `purchasedBytes` has advanced and no ceiling covers it, nor one where a
ceiling was written against money that failed to leave the wallet.

A hot Grant is topped back up to `HORIZON_SECONDS` (120) of its projected rate.
The target is the deficit — what a full horizon needs, less the headroom it
already holds. **Only an active metered Grant buys.** A prepaid bag is fixed
at purchase, so for it the loop is the split alone.

**A config is hot on its own share too** (F-027-cl). The panel cuts a config
off at its share, not at the bag, so a Grant far from spent can still have one
config seconds from its cut. When a config is inside `HORIZON_SECONDS` of its
`allocatedCeilingBytes` less its lifetime bytes, and the bag still holds
bytes, the pass re-splits (`rebalance`) with nothing bought. The concentrated
config is the fastest one. If nothing measurably runs, it is the one nearest
the end of its share, because a config the panel has cut measures no rate.
A short wallet with bytes still in the bag is reported (`refused`) rather than
thrown, and the split still moves.

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

**The first block is sized at `panel.maxLineRateBps`.** A Grant with nothing
bought has no measured rate and zero headroom, so it is hot at once; treating
an unmeasured config as idle is a user who stalls on their first download. The
cost of the assumption is bounded on both sides: a short balance buys a smaller
block rather than nothing (`contract.traffic-block.md`), and what was never
served comes back at close (F-027-r).

### The block floor, and why it is here

`MIN_BLOCK_SECONDS` (60) floors the **target**, never the horizon. Every block
is a `traffic_consumption` row in the wallet ledger, and without a floor a
Grant hovering a second inside the horizon buys one second of traffic on every
pass, for as long as the user stays hot. Flooring the target bounds that at one
row a minute per Grant at any line speed — a faster user's minute is a bigger
block, not a more frequent one.

It is here and not in `BlockPurchaseService` because this is the one place that
knows the user's rate. `purchase()` never clamps a target **up**: spending more
of a wallet than was asked for is the caller's decision (F-027-am, decided with
the user 2026-09-22).

## When the bag is spent and nothing can be bought (F-027-x)

A pass that finds `purchasedBytes - consumedBytes ≤ 0` and buys nothing asks
`suspendIfExhausted` (`traffic/exhaustion.ts`), in the same transaction. That is
two branches: no rate to size a block from — which is where a user the panel
has already stopped arrives, pass after pass — and a purchase refused for money
(`insufficient_funds`, `block_below_one_byte`), which is then answered as the
verdict rather than thrown. The same refusal with bytes still in the bag is
thrown as before: a short wallet is not yet an empty bag.

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
- **An idle Grant is never called.** A zero delta is not published. A config
  cut off before any pass put it inside its share horizon waits for the next
  delta from any config of its Grant (ADR-0092's revisit trigger).

## Running it — `cmd/server` (F-027-bu)

`cmd` starts `hot.Loop` beside the bulk pass, and it owns nothing of its own:

1. **Candidates are `hot.PostgresSource`**: every config on a panel the bulk
   pass last offered (`collect.PostgresSource.Offered`) with a share, a client,
   `present` and enabled. Headroom is the share less the cursor's lifetime,
   up and down. Membership is still `IsHot`, in Go, in one place.
2. **One driver per panel.** The candidate rides the bulk pass's driver and
   so its request budget; a panel no bulk pass has offered is read by nobody.
   Its `Configs` are the statement's, so a config created since the bulk pass
   is billed here rather than written down as unattributed.
3. **Its cursors are read in the same statement**, under the cursors' lock
   (`PostgresCursors.Merge`): a client re-keyed since the bulk pass keeps its
   cursor instead of being adopted from zero, which would restart its
   lifetime and the ceiling offset built on it.
4. **One turn per panel at a time** (`collect.TurnLocks`). Two loops
   normalising one panel against the same cursor would publish the same bytes
   under two delta ids, which `usage_delta_seen` cannot absorb. The bulk pass
   waits for a hot turn; a hot turn finding the bulk pass there steps aside
   (`PassReport.Busy`), because that read covers the hot clients too.
5. **No converger.** It writes to no panel, per the next section: a client
   list every two seconds would spend the panel's budget on nothing.

## What it will not do

It does not write to a panel — that is the convergence loop's (F-027-t). It
does not decide a share — that is the allocator's (F-027-s). The per-panel
request budget it runs under, and the ban it refuses to retry through, are
[contract.budget.md](contract.budget.md) (F-027-v) — built with this loop
rather than after it, because an unbudgeted hot loop is a denial of service on
a customer's own server. Extending a ceiling on shutdown is
[contract.resilience.md](contract.resilience.md) (F-027-w). A panel halted by a
drift event is not read here either, and a hot subset is contained by the bulk
pass's thresholds before it publishes (F-027-ab, `contract.drift.md`).
