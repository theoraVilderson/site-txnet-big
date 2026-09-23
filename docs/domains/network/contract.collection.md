---
id: network
layer: domain
status: draft
version: 14
updated: 2026-09-23
---

# Contract — network / the collection loop

A topic file of `contract.md` (§10): the bulk pass over every pull panel, the
one normaliser under it, and what happens to a byte it cannot bill. It is the
service half of invariant 18 — every measured byte billed, held or quarantined
— and it is built and proved against `internal/driver/fake` before any money
touches it (F-027-l, ADR-0074).

## The pass

`internal/collect/` is one bulk pass a minute over every pull panel:
`DefaultInterval` 60s, `DefaultConcurrency` 8 panels in flight, and
`DefaultPanelTimeout` 10s each, because the budget is per panel and one that
stalls must not spend another's turn. A panel that fails is a row in the
`PassReport`, never the end of the pass.

One minute is right for almost every user and far too slow for one: a gigabit
line empties its headroom inside an interval. `internal/hot` reads that few
sooner, on its own interval and through this same normaliser, sink and cursors
— `contract.hot-loop.md` (F-027-u). Nothing below this line can tell the two
passes apart.

One `Normaliser` holds all three arithmetics, and past it nothing knows which
family a byte came from (ADR-0074):

- **cumulative** — the rise above the cursor's last *raw* figure. A lower
  figure is a reset: the post-reset figure is published whole and flagged
  `AfterReset`, and no negative delta exists anywhere.
- **reset_on_read** — the reading *is* the delta; the read spent the counter.
- **session** — the rise above that session id's published high-water. A
  restored backup returns an id already at its mark, so it is worth nothing,
  which is the property the declaration was made to keep.

**A first reading is a baseline, never a delta:** what a counter already held
ran before we were watching.

**The plausibility cap is elapsed time x line rate, and it stretches** with the
real gap since the last reading, floored at one interval — a collector down for
two hours must not quarantine the traffic it missed. `maxLineRateBps` is
nullable, so zero is *unknown* and applies no cap; a cap of nothing would
quarantine every byte on that panel in silence.

Every byte read is billed, quarantined or written down as `unattributed`
(invariant 18), and **the cursor moves only after the publish succeeds** — a
failed pass re-reads rather than loses, and the repeat is what
`usage_delta_seen` absorbs (F-027-n). A durable `Cursors` is still to come;
until then the loop runs against `MemoryCursors`.

**A population going backward together is not a set of resets.** Before the
publish, `collect.Containment` counts this pass's cumulative resets; past 20%
and five, every post-reset delta is quarantined as `panel_drift_event`, a
halting event is raised, and the panel is not read until it is acknowledged
(F-027-ab, [contract.drift.md](contract.drift.md) "The panel-wide event").

## Where a pass goes (F-027-m)

`internal/publish` is the loop's `Sink`. **One message is one pass over one
panel**, published as `network.usage.delta` on the automation exchange, and it
carries all three streams — the deltas, the quarantines and the unattributed
rows. That is invariant 18 on the wire: a message carrying only the deltas
would drop the other two in the one place nothing goes red. A pass past 500
deltas is chunked; the other two streams ride the first chunk, once.

The routing key and every field are declared in `contracts/network/delta.json`,
because `network-service` is Go and cannot import `shared-core`. A test on each
side holds its binding to the fixture — `internal/publish/delta_contract_test.go`
and `usage-delta.contract.spec.ts` — which is the `wire.json` answer to a name
spelled in two languages (ADR-0036, C-04/C-08).

Three fields are on the message from day one although nothing reads them yet:
`panelId`, `ownershipType` and `protocol`. Bandwidth is a cost the panel's
owner pays (F-1002), and `traffic_raw_log` is partitioned by month, so adding
them later is a migration over every partition.

**A byte figure rides as a decimal string.** It is a BIGINT at both ends and
`JSON.parse` rounds past 2^53 without saying so; the consumer's schema refuses
a number rather than coercing one.

**`deltaId` is derived, never generated** — a UUIDv5 over the panel, the remote
client, the session, the instant and the two figures. A broker redelivery
therefore carries the id its first delivery carried, which is what lets
`usage_delta_seen` turn at-least-once delivery into an exactly-once effect
(F-027-n). The derivation is in the fixture, so a consumer can recompute the id
instead of trusting it.

Every publish is `mandatory` and confirmed, and an unroutable message is an
error, not a shrug: a pass that reaches no queue fails its publish, the cursor
stays and the bytes are read again. Since F-027-n the queue exists —
`metering-service` binds `network.usage.#` (ADR-0077) and turns a pass into
`traffic_raw_log`, `grant.consumedBytes`, holds, quarantines and unattributed
rows; `docs/domains/billing/contract.metering.md` is what governs that half.

