---
id: adr-0078
status: active
updated: 2026-09-23
---

# ADR 0078 — a shutdown extends a ceiling to what the wallet backs, and the figure waits in a column

- **Status:** accepted
- **Date:** 2026-09-22 (decided with the user), 2026-09-23 (written)
- **Affects units:** network, billing
- **Answers:** `network/open-questions.md` 2026-09-22, for F-027-w's half

## Context

The collector (`network-service`, ADR-0071) is the only thing that reads a
panel's counters. While it is down nothing measures, nothing buys a block and
no ceiling rises. The hot loop buys about two minutes of a user's own rate at a
time (ADR-0072, `contract.hot-loop.md`), which is right while somebody is
watching and far too little the moment nobody is: a weekly deploy is several
minutes in which every metered user runs into their ceiling with money in their
wallet. Crashes are rare; deploys are weekly. The graceful path is the one that
matters.

Removing the ceiling on the way out would serve traffic against nobody's
purchase — ADR-0072's hole, reopened at the one moment nothing is counting. So
the ceiling is **extended**, to what the user's money still backs: their share
of a bag of `purchasedBytes` plus what their wallet would buy at the Grant's
locked rate (ADR-0073).

That needs a money figure at the moment the collector exits, and the two halves
live in two processes. The write to the panel is only `network-service`'s — the
driver is there. The price of a byte is only `billing-service`'s. Nothing
carries a figure between them; the same gap left `HotLoopService.topUpIn`
without a caller.

## Options

1. **A column, kept fresh by the allocator.** `config.walletBackedCeilingBytes`,
   written by `CeilingAllocatorService` in the transaction that writes
   `allocatedCeilingBytes`. The collector reads its own table on exit.
2. **The collector reads the wallet itself.** It is already a
   `txnet_cross_tenant` member, so it could `SELECT billing.wallet` and
   `entitlement.grant` and price the bytes in Go.
3. **An internal HTTP call at SIGTERM**, collector to `billing-service` — the
   same channel the hot loop could later use.

## Decision

**Option 1.** Decided with the user on 2026-09-22.

- **It works when it is needed.** A weekly deploy usually takes both services
  down together; option 3 needs `billing-service` up at exactly that moment,
  and fails into the cut-off it exists to prevent. The column is already
  there, and survives an ungraceful exit too.
- **The boundary holds.** `network-service` still reads `network.*` and nothing
  else (`network/contract.md`), and the whole-cent rate arithmetic
  (ADR-0073) stays in one language. Option 2 would copy it into Go, which is
  the drift ADR-0036 and C-04 exist to stop.
- **It is one query.** An exit over 200 panels and 5000 configs is one `SELECT`
  per panel on its own table, not a fan-out across a process boundary.

**It is the same split over a bigger bag**, not a second opinion: the
allocator runs `allocateCeilings` again with `purchasedBytes +
bytesAffordable(rate, balance)`, same order, same floor, same sub-account caps.
The split is monotone in the bag, a property test holds it to that, and
`config_wallet_backed_ceiling_extends` CHECKs the column is never below the
allocation — a shutdown that *lowered* a ceiling would be the cut-off itself.

**The extension is never remembered.** The collector writes the panel and
records nothing: no `appliedCeilingBytes`, no cursor. The first convergence
pass after the restart finds the panel above its allocation and pulls it back
(`above_allocation`, F-027-t). The repair is the existing loop's.

## Consequences

- The figure is as stale as the last rebalance: one bulk pass for most configs,
  the hot interval for the few near a ceiling. Staleness is always in the safe
  direction — money the user had a moment ago — and a top-up between two
  rebalances is simply not in it yet.
- Every rebalance reads the wallet, and a row is written when either column
  moves. A top-up therefore costs one write per config on the next rebalance,
  which is the price of the shutdown figure being current.
- Network invariant 35 (a ceiling on a panel is never above the allocation)
  gains its one exception, bounded by this column (invariant 37).
- **Not answered here:** the hot loop's channel. That question is still open
  in `network/open-questions.md`, for F-027-u; this ADR answers F-027-w's half
  only, and does not presume the hot loop will use a column too.

## Revisit when

- A deploy strategy keeps an old collector running until the new one has
  completed a pass (blue/green). Then nobody is ever unmetered, and the
  extension becomes a crash-only path.
- The wallet changes often enough that one write per config per top-up shows
  up in `pg_stat_statements`.
