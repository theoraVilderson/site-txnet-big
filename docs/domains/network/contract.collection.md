---
id: network
layer: domain
status: draft
version: 4
updated: 2026-09-21
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
`usage_delta_seen` absorbs (F-027-n). The sink and a durable `Cursors` are
F-027-m's; until then the loop runs against the fake, in memory.

