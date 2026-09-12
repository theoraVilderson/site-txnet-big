---
id: currency
layer: domain
status: active
version: 3
updated: 2026-09-12
---

# Contract — the FX worker (currency)

Governs the loop that discovers the USD→IRR rate: backlog rows **F-0603**,
**F-0604** and **F-0605** (built), F-0606 (not built). Read it before changing
anything under `txnet-backend/worker-service/src/app/currency/`.

## TL;DR

**Completely decoupled from the request path.** Nothing here runs while a
request is waiting. A tick (ADR-0027) drives a five-step loop; a request reads
the rate the loop last published, never a source.

| step | what | row | built |
|---|---|---|---|
| 1 | every active source queried concurrently, 3s each | F-0603 | yes |
| 2 | failures and out-of-band values discarded, `minSources` must remain, **median** | F-0604 | yes |
| 3 | a move beyond `maxDeviationPercent` rejected + critical alert | F-0605 | yes |
| 4 | snapshot written, rate cached in Redis `fx:rate:{code}` | F-0606 | no |
| 5 | every quoted price records its `rateSnapshotId` | F-0606 | no |

**This loop computes and gates a rate and still publishes nothing.** Steps 1
to 3 run; an accepted median lands in the run log and nowhere else. No caller
may read a rate from this unit until F-0606 writes the snapshot and the cache
entry.

## What is built

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| poll the active sources | the source list | one outcome per source — rial rate + latency, or a reason + latency | async, off the request path | **none — it does not throw** |
| reduce the outcomes (`reduceFxReads`) | the outcomes + `{minSources, sanityMinRial, sanityMaxRial}` | the median rial rate + the sources used + what was discarded and why, **or** a shortfall with the same discard list | sync, pure | **none — a shortfall is a value, not a throw** |
| gate the move (`gateFxDeviation`) | the median + the last accepted rate (or null) + `maxDeviationPercent` | accepted, with how far it moved, **or** rejected, with the move, the baseline and the band | sync, pure | **none — a refusal is a value, not a throw** |
| the `fx_rate_refresh` job | a tick | `bot_execution_log` row: per-source readings and latencies, the discard reasons, the median, `accepted` and the deviation | async | `FX_SOURCES` empty/unknown, or fewer than `minSources` readings survived — the run is `failed`. A **refused** rate is also `failed`, but by returning rather than throwing, so the numbers survive |

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

## What F-0605 refuses, and what it cannot yet

| knob | default | what it is for |
|---|---|---|
| `FX_MAX_DEVIATION_PERCENT` | `5` | how far the median may move from the **last accepted** rate |

**A different question from the band, not a tighter version of it.** The band
is absolute and asks whether a number can be a price at all. This gate is
relative and asks whether the price can have *moved* this far since the last
rate we accepted — which makes it the one step that catches the failure the
band is documented as unable to catch: a toman order book read as rial. That
reading is in band, every source agrees with it because they are all read the
same way, the median passes it through, and it is ten times wrong. Against the
last accepted rate it is a 90% fall.

**The baseline is the last *accepted* rate, never the last computed one.** A
rejected reading does not become the next baseline; if it did, two polls of a
broken source would walk the rate anywhere in 5% steps, which is the attack the
row exists to stop. `gateFxDeviation` cannot get this wrong — it holds nothing
and takes the baseline as an argument — so the rule is the job's to keep.

**"Beyond" is strict and symmetric.** Exactly `maxDeviationPercent` is a move of
that size and not one beyond it, and a fall is as suspicious as a rise.

**A refusal keeps the old rate, which is why the alert is not optional.** The
visible consequence of this gate working is that nothing changes — the platform
goes on quoting the last accepted rate, and a stale rate answers every query
exactly like a fresh one. A legitimate move larger than the band therefore
costs one refused poll and one alert, and recovers on a later one only because
the market keeps going; the gate does not re-baseline itself.

**The baseline lives in the job's memory until F-0606.** There is nowhere else
for it yet: `currency.CurrencyExchangeRate` and `fx:rate:{code}` are F-0606's
row. Two consequences, both real and both closing there — a restart is a cold
start, so the first poll after one is **ungated**; and two replicas gate against
their own histories rather than a shared one. F-0604's quorum and band are what
guard the ungated poll.

## The alert (F-0605's other half)

A rejection is an operator's problem, not a tenant's: an Alertmanager rule over
a metric, the shape F-067-g set for the queue, and not a notification row.

- `FxRateJob` writes `accepted` and `rejectedDeviationPercent` into the run's
  `metricsJson`.
- `postgres-exporter` reads them (`config-dev/postgres-queries.yaml`, query
  `currency_fx`) — Postgres and not a `/metrics`, because ADR-0027 makes
  `worker-service` a process that serves no requests.
- `config-dev/currency.rules.yml` alerts: `CurrencyFxRateRejected` (critical, no
  threshold — any refusal), `CurrencyFxRateStale` (critical, nothing accepted
  for 30 minutes), `CurrencyFxRateNeverAccepted` (warning, the schedule was
  never created).

**The run's `status` cannot carry this.** An accepted rate polled while one
exchange was down is `partial`, not `success`, because `errorsCount` carries
the discards — so `status` cannot separate a refusal from a dead source, and
those are a critical and a warning. That is why the job writes `accepted`
explicitly, and why renaming that key disarms the alert without breaking
anything visible. How it is wired: `docs/operations/observability.md`.

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
8. **The gate is pure and total too**, for the same reason and one more: a gate
   that threw would take the loop down on exactly the poll it exists to survive.
9. **A rejected rate never becomes the baseline.** See above — this is the whole
   security of the gate, and it is a property of the caller.
10. **A refusal is a `failed` run that keeps its numbers.** It returns rather
    than throwing, because a thrown error reaches `bot_execution_log` as
    `{ error: <message> }` and the per-source readings, the median and the size
    of the move — the entire content of the alert — are lost. `itemsProcessed:
    0` with a non-zero `errorsCount` is the same `failed` status by the same
    rule (`TickConsumer.statusOf`), with the evidence intact.

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

Nobody yet, deliberately (see the TL;DR) — F-0605 changed no published
interface, so there is no consumer to notify. The first consumer is F-0606's
cache entry, read by billing's rial path (ADR-0019).

The one cross-unit coupling this row did add is not an interface: `ops-observability`
now has a rule file whose expressions depend on two `metricsJson` key names this
unit writes. That is named in both places on purpose.
