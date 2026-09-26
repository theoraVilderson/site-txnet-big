---
id: adr-0091
status: active
updated: 2026-09-26
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
