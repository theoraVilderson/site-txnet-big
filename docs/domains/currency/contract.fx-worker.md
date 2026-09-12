---
id: currency
layer: domain
status: active
version: 2
updated: 2026-09-12
---

# Contract — the FX worker (currency)

Governs the loop that discovers the USD→IRR rate: backlog rows **F-0603** and
**F-0604** (built), F-0605 / F-0606 (not built). Read it before changing
anything under `txnet-backend/worker-service/src/app/currency/`.

## TL;DR

**Completely decoupled from the request path.** Nothing here runs while a
request is waiting. A tick (ADR-0027) drives a five-step loop; a request reads
the rate the loop last published, never a source.

| step | what | row | built |
|---|---|---|---|
| 1 | every active source queried concurrently, 3s each | F-0603 | yes |
| 2 | failures and out-of-band values discarded, `minSources` must remain, **median** | F-0604 | yes |
| 3 | a move beyond `maxDeviationPercent` rejected + critical alert | F-0605 | no |
| 4 | snapshot written, rate cached in Redis `fx:rate:{code}` | F-0606 | no |
| 5 | every quoted price records its `rateSnapshotId` | F-0606 | no |

**This loop computes a rate and still publishes nothing.** Steps 1 and 2 run;
the median lands in the run log and nowhere else. No caller may read a rate
from this unit until F-0606, because a rate anything is priced from has to pass
F-0605's deviation gate first and that gate does not exist yet.

## What is built

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| poll the active sources | the source list | one outcome per source — rial rate + latency, or a reason + latency | async, off the request path | **none — it does not throw** |
| reduce the outcomes (`reduceFxReads`) | the outcomes + `{minSources, sanityMinRial, sanityMaxRial}` | the median rial rate + the sources used + what was discarded and why, **or** a shortfall with the same discard list | sync, pure | **none — a shortfall is a value, not a throw** |
| the `fx_rate_refresh` job | a tick | `bot_execution_log` row: per-source readings and latencies, the discard reasons, the median | async | `FX_SOURCES` empty/unknown, or fewer than `minSources` readings survived — the run is `failed` |

## The sources (D-22)

Public USDT/IRT order books, no API key, chosen because they stay reachable
from inside Iran during a national-internet shutdown. **The mid of best bid and
best ask**, not a last trade price: on a thin book the last trade is whatever
one person happened to pay.

| key | unit | in `FX_SOURCES` by default | why |
|---|---|---|---|
| `nobitex` | rial | yes | endpoint stated in full by D-22 |
| `tabdeal` | toman | yes | endpoint stated in full by D-22 |
| `wallex` | toman | no | URL is this repo's guess, not D-22's — unverified |
| `bitpin` | toman | no | same |

`unit` is load-bearing. A toman source read as rial is a tenfold error that no
single-source check catches, and F-0605's 5% band would then reject the correct
rate for ever while reporting only "moved too far".

**The list is config, not code** (`FX_SOURCES`). D-22 ends on a compliance
question rather than a technical one: Nobitex, Wallex and Bitpin were put on
the US OFAC list in June 2026, so dropping one has to be an environment change.

## What F-0604 discards, and what it does not

| knob | default | what it is for |
|---|---|---|
| `FX_MIN_SOURCES` | 2 | how many readings must survive before a median means anything |
| `FX_SANITY_MIN_RIAL` | `100000` | the hard band's floor, rial per USDT, inclusive |
| `FX_SANITY_MAX_RIAL` | `10000000` | its ceiling, inclusive |

**The band rejects what cannot be a price, not disagreement.** It is absolute
and static because this step has no history to compare against — a cold start
has no last accepted rate — so its only job is the answer that parses and is
still nonsense: an amount column read as a price, a stale zero. It is wide,
roughly a factor of ten either side of where this market has been.

**It does not catch a tenfold unit error and must not be tightened until it
does.** `FxSource.unit` is what prevents that error and F-0605's gate is what
notices it afterwards. A band tight enough to catch 10x would reject the true
rate the first time the market moved, and this market moves. The edges are this
repo's estimate rather than D-22's (`open-questions.md`); every reading is in
the run log, so they are tightened against evidence or not at all.

**Fewer than `minSources` is no rate, not a best effort.** One surviving source
is precisely the broken API this row defends against, with nothing left to
outvote it. The run is `failed`, with a reason naming every source and what
happened to it; the last accepted rate stays live once F-0606 exists. Two is
the catalog's default and the minimum that can produce a rate at all — it is
not yet enough to *outvote* an outlier, which takes three, and is worth raising
the moment a third exchange has been seen to answer.

**The median, and on an even sample the lower of the two middle readings.** Not
their average: an average of two quotes is a number no exchange published, and
with the default of two sources it is exactly the mean the row forbids. The
lower middle is deterministic, is always a price some exchange actually quoted
— which is what F-0606's snapshot has to be able to point at — and errs toward
the cheaper dollar, the side that cannot overcharge a user.

## Rules this step holds

1. **Concurrent.** Sources polled in sequence are readings of different
   moments, and a median over them is a median of nothing in particular.
2. **Three seconds per source, not per poll.** A dead exchange costs its own
   outcome and holds up no other.
3. **The poller never throws.** Sources are *expected* to fail — that is what
   F-0604's median is for. A poller that threw on the first refusal would hand
   F-0604 an empty sample whenever one exchange was down.
4. **The job never succeeds quietly.** Zero sources configured, an unknown key,
   or every source failing are each recorded as a `failed` run rather than as a
   healthy "0 processed" (automation invariant #3).
5. **A crossed book is a failure, not a mid.** Bid above ask means the sides
   were read at different moments or the parser has the order backwards; both
   are wrong in a way averaging would hide.
6. **Never the mean, at any sample size.** The mean has no breakdown point:
   one in-band but wrong reading moves it by its whole error over the sample
   size, and this sample is two to four. This is the rule the whole row exists
   for — "$100 of service must not sell for 600,000 rials because of one
   broken API response".
7. **The reduction is pure and total.** It reads no clock, no config and no
   network, and every failure is a returned value. That is what lets the
   median's behaviour on a hostile sample be a unit test rather than a story.

## How it is scheduled

Every five minutes, and that is a **`bot_schedule` row, not a constant**. The
job registers itself as `fx_rate_refresh` on boot; an admin gives it a
`cron_expression` schedule of `*/5 * * * *` through `/admin/workers` (F-031-b).
`AUTOMATION_TICK_INTERVAL_MS` is 60s by default, so the publisher finds a
five-minute occurrence well inside its own interval. No change to `automation`'s
contract was needed and none was made.

**Where it runs is not settled.** D-22: these exchanges are reachable during a
national shutdown *only if this process runs on a node inside Iran*; a node
abroad loses them exactly when the rate matters most. That placement is
`automation`'s call. F-0603 ships the per-source latencies in the run log
precisely so the decision has evidence — see `open-questions.md`.

## Consumers

Nobody yet, deliberately (see the TL;DR) — F-0604 changed no published
interface, so there is no consumer to notify. The first consumer is F-0606's
cache entry, read by billing's rial path (ADR-0019).
