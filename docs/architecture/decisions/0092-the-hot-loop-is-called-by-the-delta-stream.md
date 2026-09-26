---
id: adr-0092
status: active
updated: 2026-09-26
---

# ADR 0092 — the hot loop's money half is called by the delta stream

- **Status:** accepted
- **Date:** 2026-09-26
- **Affects units:** network (`contract.hot-loop.md`; the code is billing's `traffic/hot-loop.consumer.ts`, `traffic/hot-loop.queue.ts`, `traffic/horizon.ts`)
- **Decision row:** `network/open-questions.md`, 2026-09-22 row: the user answered "the delta stream" on 2026-09-26. Built in F-027-cl

## Context
ADR-0072 splits the hot loop in two. `network-service` knows which configs
are near a ceiling and reads them sooner (F-027-u, F-027-bu), and
`billing-service` buys the next block and re-splits the bag
(`HotLoopService.topUpIn`). Nothing called `topUpIn`. Reported 2026-09-26
on panel 5922ac13: a prepaid 1 GiB Grant was split 512/512 over two
inbounds, and the busy one was cut off at 512 MiB while the other half sat
idle. Even with a caller, `topUpIn` only re-split after buying a block, and
a prepaid Grant never buys one.

## Decision
We will give `billing-service` a durable queue of its own
(`HOT_LOOP_QUEUE`, `txnet.billing.hot-loop`) bound to `network.usage.#` on
the automation exchange, beside `metering-service`'s. For each collection
pass it runs `HotLoopService.topUp` once per Grant the pass carried a delta
for, under that Grant's tenant. Prefetch is fixed at 1 because the rate
samples live in memory. `topUpIn` also re-splits, buying nothing, when some
config is inside `HORIZON_SECONDS` of its **own share** while the bag still
holds bytes. Only an active metered Grant buys a block. A short wallet with
bytes left is reported in the outcome, not thrown.

## Consequences
- Positive: the channel already runs at the hot rate, because the collector
  reads a hot config every 2–60 s and publishes each read. No route, timer or
  new event is needed. A config near the end of its share gets the bag moved
  to it before the panel cuts it off.
- Negative / accepted cost: the two consumers race. `consumedBytes` and the
  counter cursors may not include the pass that woke the top-up yet, so
  headroom is overstated by at most one pass. The quarter-interval rule in
  `contract.hot-loop.md` already assumes that much goes unseen. A bulk pass
  opens one transaction per touched Grant, about as many as metering opens
  per delta. Rates are per process: a second replica would measure a gap it
  did not see.
- What this forecloses: nothing. Zero deltas are not published, so a Grant
  whose configs are all idle is never touched. A config cut off before its
  share horizon was reached waits for the next delta from any config of its
  Grant. A timer that scans for such Grants can be added beside this.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| A route `network-service` calls on a hot config | a second channel, with its own auth and retry, carrying what the delta stream already carries |
| A timer in `billing-service` that scans for hot Grants | a table scan per tick, and a rate measured over the timer's interval instead of the collector's |
| Share `metering-service`'s queue, or call it from metering | billing a delta and topping up a Grant are two consumers of one fact; chaining them makes a slow top-up delay billing |

## Revisit trigger
`billing-service` runs more than one replica (the rate samples must then be
keyed per panel or moved out of memory), or idle Grants cut off at a share
are reported.
