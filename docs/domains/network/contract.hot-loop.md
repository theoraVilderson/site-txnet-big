---
id: network
layer: domain
status: draft
version: 10
updated: 2026-09-22
---

# The hot loop — the few configs near their ceiling, in seconds

A topic file of `contract.md` (§10). What governs `network-service/internal/hot`
and `billing-service/src/app/traffic/horizon.ts` (F-027-u, ADR-0072): when a
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
already holds.

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

## Two halves, two processes, no channel between them

The collector is Go and the purchase is in-process in `billing-service`, so
nothing today carries "this Grant is hot" from the one that knows it to the one
that acts on it. Both halves compute time to ceiling from their own side's
data, which is why the figure is defined here once rather than passed.
`topUpIn` therefore has **no caller yet** — the same state `RemainderCredit` is
in. What connects them is a decision, not an oversight, and it is open in
`open-questions.md`.

## What it will not do

It does not write to a panel — that is the convergence loop's (F-027-t). It
does not decide a share — that is the allocator's (F-027-s). The per-panel
request budget it runs under, and the ban it refuses to retry through, are
[contract.budget.md](contract.budget.md) (F-027-v) — built with this loop
rather than after it, because an unbudgeted hot loop is a denial of service on
a customer's own server. Extending a ceiling on shutdown is
[contract.resilience.md](contract.resilience.md) (F-027-w).
