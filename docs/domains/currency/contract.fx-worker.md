---
id: currency
layer: domain
status: active
version: 1
updated: 2026-09-12
---

# Contract — the FX worker (currency)

Governs the loop that discovers the USD→IRR rate: backlog rows **F-0603**
(built) and F-0604 / F-0605 / F-0606 (not built). Read it before changing
anything under `txnet-backend/worker-service/src/app/currency/`.

## TL;DR

**Completely decoupled from the request path.** Nothing here runs while a
request is waiting. A tick (ADR-0027) drives a five-step loop; a request reads
the rate the loop last published, never a source.

| step | what | row | built |
|---|---|---|---|
| 1 | every active source queried concurrently, 3s each | F-0603 | yes |
| 2 | failures and out-of-band values discarded, `minSources` must remain, **median** | F-0604 | no |
| 3 | a move beyond `maxDeviationPercent` rejected + critical alert | F-0605 | no |
| 4 | snapshot written, rate cached in Redis `fx:rate:{code}` | F-0606 | no |
| 5 | every quoted price records its `rateSnapshotId` | F-0606 | no |

**Until F-0604 lands, this loop publishes no rate.** It polls and it records
what it saw. `FxRateJob` says so in its description and its run log; no caller
should read a rate from this unit yet, because there is not one.

## What F-0603 provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| poll the active sources | the source list | one outcome per source — rial rate + latency, or a reason + latency | async, off the request path | **none — it does not throw** |
| the `fx_rate_refresh` job | a tick | `bot_execution_log` row with a per-source metrics object | async | every source failed, or `FX_SOURCES` is empty/unknown — the run is `failed` |

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

Nobody yet, deliberately (see the TL;DR). The first consumer is F-0606's cache
entry, read by billing's rial path (ADR-0019).
