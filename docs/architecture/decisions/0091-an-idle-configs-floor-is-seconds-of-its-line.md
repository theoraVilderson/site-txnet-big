---
id: adr-0091
status: active
updated: 2026-09-27
---

# ADR 0091 — an idle config's floor is seconds of its line, not a fixed figure

- **Status:** accepted
- **Date:** 2026-09-26
- **Affects units:** network (`contract.ceiling.md`; the allocator is billing's `traffic/ceiling-allocator.ts`)
- **Decision row:** D-49 (the user delegated the call: "whichever is right long-term, at high speed and high volume")

## Context
ADR-0072 splits a Grant's bag across its configs in three passes: what each
has served, a floor above that, then everything left to the hot config. The
floor was a flat 100 MiB. Reported 2026-09-26: a 50 GB purchase placed `all`
on two inbounds read 49.9 GB / 0.09 GB on x-ui.

The split was doing what it was written to do, but the floor is the one
figure in the traffic design still sized in bytes. 100 MiB is 0.8 s on a
gigabit line. A config that starts drawing is seen on the next bulk read (up
to 60 s) and rebalanced inside the hot loop's horizon (120 s), so a user who
switches inbounds at line rate is cut off for up to a minute. The same floor
is all an idle config has while the collector is down.

## Decision
We will size pass 2's floor per config in seconds of its panel's line rate:
`maxLineRateBps / 8 × IDLE_FLOOR_SECONDS` (180 s = the bulk interval plus the
horizon), at least the 100 MiB floor, and at most an even share of what pass 1
left, so a small bag splits evenly. A panel that declares no line rate gives
the even share: nothing says how fast it drains. Pass 3 is unchanged — the
rest goes to the hot config, then the heaviest.

## Consequences
- Positive: an idle config survives the loop's reaction time at any line
  speed; a small bag reads as an even split on the panel; the floors together
  never exceed what pass 1 left, so the split stays monotone in the bag and the
  shutdown figure (F-027-w) keeps extending rather than lowering.
- Negative / accepted cost: on a fast panel an idle config holds more of the
  bag (22.5 GB of 50 at gigabit), so the hot config is topped up by the hot
  loop sooner. That costs rebalances, never bytes: `Σ ceilings ≤
  purchasedBytes` still holds by construction.
- What this forecloses: nothing; a measured per-config rate can replace the
  panel's line rate in the same formula later.

## Alternatives rejected
| Option | Why rejected |
|---|---|
| Keep the flat 100 MiB | cut-off at line rate before any loop can react; the problem reported, only disguised |
| An even split, always | on a large bag an idle config holds hundreds of GB; near the end each rebalance halves the remainder, and a metered Grant buys twice as often for the same traffic |
| A bigger flat floor (1 GiB) | still bytes: 8 s at gigabit, and a third of a small bag |

## Revisit trigger
Per-config rates are measured well enough to replace the panel's line rate, or
the bulk interval (`collect.DefaultInterval`) or `HORIZON_SECONDS` changes —
`IDLE_FLOOR_SECONDS` is their sum.

## Amendment 2026-09-26 — the hot config is not held to an even share (F-027-cr)

**Context.** "At most an even share of what pass 1 left" counted the hot
config among the N. At five gigabit configs a 100 GB bag is under 5 × 22.5 GB,
so every floor was the even share and the config actually consuming got 1/5 per
re-split. With the guard band (F-027-co, 875 MB at 25 MB/s) that became a fast
user re-split and cut over and over through the last ~4 GB (worked out with the
user, 2026-09-26).

**Decision** (user, 2026-09-26). With a hot config named, the idle configs'
floors together take at most **half** of what pass 1 left — each at most
`left / 2 / (N - 1)` — and the hot config's own floor is nothing, pass 3 giving
it the rest. Idle floors stay seconds of line; a bulk pass (no hot config)
keeps the even share. At two configs this is the old rule.

**Consequences.** The hot config holds at least half the rest whatever N, so a
bag converges in a handful of re-splits; the tail inside the band shrinks from
~4 GB to ~1.75 GB in the case above. An idle config holds less (12.5 GB of
100 at five gigabit inbounds, was 20) — still more than its 180 s of line in
most bags. The floors stay monotone in the bag, so the shutdown figure still
extends (F-027-w); the property test holds the half.

**Rejected.** A 100 MiB floor for a config idle for an hour: it concentrates
harder, but the switch to a backup inbound after a filtering is exactly a
long-idle config starting at line rate — the cut this ADR was written against.

## Amendment 2026-09-27 — a metered Grant's reserve does not thin with N (F-027-cs)

**Context.** The floors come out of the bag, so they divide by the config
count: 100 inbounds on 1 GiB kept 5.4 MB each after a re-split, and a first
connect or a switch to a backup inbound was cut in under a second. This ADR
holds only for a bag ≥ `2(N-1) × rate × 180 s`. A metered bag is small by
design, the horizon buying ~120 s ahead. A panel enforces its own client, so a
reserve shared by N configs has to be written onto all N: it is an overcommit
or it is nothing.

**Decision** (user, 2026-09-27). On a **metered** Grant only, every config's
ceiling is at least `served + min(wallet-affordable bytes, its seconds of
line)`, applied after the split and out of nobody's share. Entitlement
invariant 8 is amended to allow it. A prepaid Grant is unchanged.

**Consequences.** The reserve does not depend on N. One config drawing it takes the Grant
past its bag, and the hot loop buys the block that covers it. Several drawing
at once from a nearly empty wallet is an uncharged overrun, bounded by
`N × min(wallet, 180 s of line)` per reaction window. On a low wallet, every
top-up moves every idle ceiling (a panel write each; F-027-ct orders them).

**Rejected.** A reserve for every Grant: on a prepaid bag nothing pays it back,
and sharing inbounds among many people would turn it into up to (N-1)× the bag
free, a leak that grows with resellers. Closing the row as a known limit
(keeping invariant 8 strict) would leave every metered Grant with many inbounds cut on
its first connect.
