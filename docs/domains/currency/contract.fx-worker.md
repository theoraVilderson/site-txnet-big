---
id: currency
layer: domain
status: active
version: 4
updated: 2026-09-12
---

# Contract — the FX worker (currency)

Governs the loop that discovers the USD→IRR rate: backlog rows **F-0603**,
**F-0604**, **F-0605**, **F-0606-a** and **F-0606-b** (in `billing`) — all
built. Read it before changing anything under
`txnet-backend/worker-service/src/app/currency/`.

## TL;DR

**Completely decoupled from the request path.** A tick (ADR-0027) drives a
five-step loop; a request reads the rate the loop last published, never a
source.

| step | what | row | built |
|---|---|---|---|
| 1 | every active source queried concurrently, 3s each | F-0603 | yes |
| 2 | failures and out-of-band values discarded, `minSources` must remain, **median** | F-0604 | yes |
| 3 | a move beyond `maxDeviationPercent` rejected + critical alert | F-0605 | yes |
| 4 | snapshot written, rate cached in Redis `fx:rate:{code}` | F-0606-a | yes |
| 5 | every quoted price records its `rateSnapshotId` | F-0606-b | yes |

**This loop now publishes** — an accepted median is a
`currency.CurrencyExchangeRate` row cached under `fx:rate:{currencyCode}`, the
rate ADR-0019 requires before anything can be priced in rial. Step 5 is built,
in `billing` (F-0606-b); the read of this key, F-092-c, is not.

**A reader takes the snapshot from the cache and falls back to the table**, and
must do both — the key is a cache of the row, not a second copy of the number.
It holds `{snapshotId, currencyCode, rate, source, effectiveAt}` so a caller can
record the id (F-0606-b) and judge the age (F-0607-a) without a query. **The
ladder is the reader's**: this unit publishes the last rate it accepted and
when, not a judgement about whether that is fresh enough to quote.

## What is built

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| poll the active sources | the source list | one outcome per source — rial rate + latency, or a reason + latency | async, off the request path | **none — it does not throw** |
| reduce the outcomes (`reduceFxReads`) | the outcomes + `{minSources, sanityMinRial, sanityMaxRial}` | the median rial rate + the sources used + what was discarded and why, **or** a shortfall with the same discard list | sync, pure | **none — a shortfall is a value, not a throw** |
| gate the move (`gateFxDeviation`) | the median + the last accepted rate (or null) + `maxDeviationPercent` | accepted, with how far it moved, **or** rejected, with the move, the baseline and the band | sync, pure | **none — a refusal is a value, not a throw** |
| publish / read back the snapshot (`FxRateSnapshotStore`) | the accepted rate / — | the `CurrencyExchangeRate` row (id + `effectiveAt`) and whether the cache write landed / the last accepted rate, or null before the first snapshot | async | a missing `FX_QUOTE_CURRENCY_CODE` currency row throws. A failed cache **write** does not; an unreadable cache **read** falls through to the table |
| the `fx_rate_refresh` job | a tick | `bot_execution_log` row: per-source readings and latencies, the discard reasons, the median, `accepted` and the deviation | async | `FX_SOURCES` empty/unknown, or fewer than `minSources` readings survived — the run is `failed`. A **refused** rate is also `failed`, but by returning rather than throwing, so the numbers survive |

## The sources (D-22)

Public USDT/IRT order books, no API key, chosen because they stay reachable from
inside Iran during a national-internet shutdown. **The mid of best bid and best
ask**, not a last trade price: on a thin book the last trade is whatever one
person happened to pay.

Four are implemented (`fx-source.ts`, which is where each one's endpoint and its
`unit` live). `nobitex` and `tabdeal` are in the `FX_SOURCES` default because
D-22 states their URLs in full; `wallex` and `bitpin` are this repo's guess at
theirs and are off until someone has watched them answer.

`unit` is load-bearing: a toman source read as rial is a tenfold error no
single-source check catches, and F-0605's band would then reject the correct
rate for ever while reporting only "moved too far". **The list is config, not
code** (`FX_SOURCES`) — D-22 ends on a compliance question rather than a
technical one, since Nobitex, Wallex and Bitpin were put on the US OFAC list in
June 2026, so dropping one has to be an environment change.

## What F-0604 discards, and what it does not

| knob | default | what it is for |
|---|---|---|
| `FX_MIN_SOURCES` | 2 | how many readings must survive before a median means anything |
| `FX_SANITY_MIN_RIAL` | `100000` | the hard band's floor, rial per USDT, inclusive |
| `FX_SANITY_MAX_RIAL` | `10000000` | its ceiling, inclusive |

**The band rejects what cannot be a price, not disagreement.** Absolute and
static, because this step has no history to compare against — its only job is
the answer that parses and is still nonsense: an amount column read as a price,
a stale zero. Roughly a factor of ten either side of where this market has been;
the edges are this repo's estimate, not D-22's (`open-questions.md`).

**It does not catch a tenfold unit error and must not be tightened until it
does** — `FxSource.unit` prevents it and F-0605's gate notices it. A band tight
enough to catch 10x would reject the true rate the first time this market
moved.

**Fewer than `minSources` is no rate, not a best effort.** One surviving source
is precisely the broken API this defends against, with nothing left to outvote
it: the run is `failed`, naming every source and what happened to it, and the
last accepted rate stays live because it is a row and a key rather than the
outcome of this poll. Two is the catalog's default and the minimum that produces
a rate at all — outvoting an outlier takes three, so raise it the moment a third
exchange has been seen to answer.

**The median, and on an even sample the lower of the two middle readings.** Not
their average: an average of two quotes is a number no exchange published, and
at the default of two sources it is exactly the mean the row forbids. The lower
middle is deterministic, is always a price some exchange actually quoted — what
the snapshot points at — and errs toward the cheaper dollar.

## What F-0605 refuses, and what it cannot yet

| knob | default | what it is for |
|---|---|---|
| `FX_MAX_DEVIATION_PERCENT` | `5` | how far the median may move from the **last accepted** rate |

**A different question from the band, not a tighter version of it.** The band
is absolute and asks whether a number can be a price at all; this gate is
relative and asks whether the price can have *moved* this far since the last
rate we accepted. That makes it the one step that catches the failure the band
cannot: a toman order book read as rial is in band, agreed on by every source
because they are all read the same way, and ten times wrong — against the last
accepted rate, a 90% fall.

**The baseline is the last *accepted* rate, never the last computed one.** A
rejected reading does not become the next baseline; if it did, two polls of a
broken source would walk the rate anywhere in 5% steps, which is the attack this
exists to stop. `gateFxDeviation` holds nothing and takes the baseline as an
argument, so the rule is the caller's to keep. **"Beyond" is strict and
symmetric**: exactly `maxDeviationPercent` is a move of that size and not one
beyond it, and a fall is as suspicious as a rise.

**A refusal keeps the old rate, which is why the alert is not optional.** The
visible consequence of this gate working is that nothing changes — a stale rate
answers every query exactly like a fresh one. A legitimate move larger than the
band costs one refused poll and one alert, and recovers later only because the
market keeps going: the gate does not re-baseline itself.

**The baseline is durable and shared since F-0606-a.** It was a field on
`FxRateJob` while there was nowhere else for it to live, so a restart was a cold
start — the first poll after one **ungated** — and two replicas gated against
their own histories. Both closed with the snapshot:
`FxRateSnapshotStore.lastAccepted` reads `fx:rate:{code}` and falls back to the
newest `CurrencyExchangeRate` row, and the job reads it at the top of every run
rather than caching it in a field, which would rebuild the per-replica history
this removed. The one remaining cold start is the real one: before the first
snapshot the platform has ever written, where F-0604's quorum and band are the
only guard and that is correct.

## What F-0606-a publishes

| knob | default | what it is for |
|---|---|---|
| `FX_QUOTE_CURRENCY_CODE` | `IRR` | which `currency.code` the snapshots and the cache entry are written against |

**The row is the truth, the key is a cache of it, and the row is written
first** — the other order would publish, for as long as the write took, a rate
no snapshot backs, the one state ADR-0019 says the rial path must never be in.

**Append-only means no earlier row is touched at all** (invariant #3) — not its
`rate`, not its `isActive`. "The current rate" is the newest `effectiveAt`,
which the `[currencyId, effectiveAt desc]` index answers; deactivating the
previous row to say so rewrites history for a query that does not need it, and
F-0606-b now points invoices at these rows by id, under a `RESTRICT` FK.

**No TTL on the key, deliberately.** F-0607-a's ladder is a function of the
snapshot's age, so an expiry would delete the evidence it is made of: a rate the
ladder would have called *degraded* arrives as *no rate at all*, its bottom
rung, with nothing failing anywhere. The key is rewritten every accepted poll,
and the table is what makes the missing expiry safe.

**The worker will not create the `currency` row it quotes against**: that row
carries `isBaseCurrency` and `decimalPlaces`, and a job guessing at those is how
a platform acquires a second base currency (invariant #1). A missing code is a
`failed` run naming it — and **nothing else writes those rows either** (no seed,
no admin screen: `open-questions.md`).

**A failed cache write is reported, not thrown**; a failed cache *read* falls
through to the table. By the time the key is written the rate is durable, so
throwing would record a run that published nothing when it published the rate —
`cached: false` and a non-zero `errorsCount` say it instead. And a baseline that
vanished whenever Redis did would make every poll the ungated cold start.

## The alert (F-0605's other half)

A rejection is an operator's problem, not a tenant's: an Alertmanager rule over
a metric, the shape F-067-g set for the queue, and not a notification row. The
job writes `accepted` and `rejectedDeviationPercent` into `metricsJson`,
`postgres-exporter` reads them (query `currency_fx` — Postgres and not a
`/metrics`, because ADR-0027 leaves this process serving no requests), and
`config-dev/currency.rules.yml` alerts on them: `CurrencyFxRateRejected`
(critical, any refusal), `CurrencyFxRateStale` (critical, nothing accepted for
30 minutes), `CurrencyFxRateNeverAccepted` (warning, no schedule). Wiring:
`docs/operations/observability.md`.

**The run's `status` cannot carry this.** An accepted rate polled while one
exchange was down is `partial`, not `success`, so `status` cannot separate a
refusal from a dead source — and those are a critical and a warning. Hence the
explicit `accepted` key, and hence renaming it disarms the alert without
breaking anything visible.

## Rules this step holds

1. **Concurrent, three seconds per source, not per poll.** Sources polled in
   sequence are readings of different moments, and a dead exchange must hold up
   no other.
2. **The poller never throws, and neither do the reducer or the gate.** Sources
   are expected to fail; a step that threw would take the loop down on exactly
   the poll it exists to survive. Every failure is a returned value.
3. **The job never succeeds quietly.** Zero sources configured, an unknown key,
   every source failing, or fewer than `minSources` surviving are each a
   `failed` run and never a healthy "0 processed" (automation invariant #3).
4. **A crossed book is a failure, not a mid.** Bid above ask means the sides
   were read at different moments or the parser has them backwards.
5. **Never the mean, at any sample size.** It has no breakdown point: one
   in-band but wrong reading moves it by its whole error over a sample of two to
   four. The rule the whole feature exists for — "$100 of service must not sell
   for 600,000 rials because of one broken API response".
6. **A rejected rate never becomes the baseline**, which is read from the
   snapshot, never held in a field.
7. **The rate table is append-only and the cache is a cache.** A snapshot is an
   `INSERT` and never an `UPDATE`; a reader that misses the key reads the table
   rather than concluding there is no rate.
8. **A refusal is a `failed` run that keeps its numbers.** It returns rather
   than throwing: a thrown error reaches `bot_execution_log` as
   `{ error: <message> }`, losing the readings, the median and the size of the
   move — the entire content of the alert. `itemsProcessed: 0` with a non-zero
   `errorsCount` is the same `failed` status (`TickConsumer.statusOf`), with the
   evidence intact.

## How it is scheduled

Every five minutes, and that is a **`bot_schedule` row, not a constant**. The
job registers itself as `fx_rate_refresh` on boot; an admin gives it a
`cron_expression` of `*/5 * * * *` through `/admin/workers` (F-031-b), and
`AUTOMATION_TICK_INTERVAL_MS` (60s) finds that occurrence well inside its own
interval. No change to `automation`'s contract was needed or made.

**Which node it runs on is `automation`'s call and is not settled**; the run
log's per-source latencies are the evidence for it (`open-questions.md`).

## Consumers

**F-0606-a is this unit's first published interface**, so this list starts here
rather than staying empty: `fx:rate:{currencyCode}`
(`docs/platform/redis-keyspace/contract.md`) and the `CurrencyExchangeRate` rows
behind it.

The consumers it is for are `billing`'s: the rial deposit path and the
staleness ladder, which reads `effectiveAt` (F-0607-a/b). **`billing` is ready
for the first** — F-0606-b made `PriceRequest.liveRate` a `{snapshotId, rate}`
pair, so nothing can price without saying which row it used. The read is what
is missing: `DepositQuoteService` still passes `liveRate: null` until F-092-c.

The other cross-unit coupling is not an interface: `ops-observability` has a
rule file whose expressions depend on two `metricsJson` key names this unit
writes — named in both places on purpose.
