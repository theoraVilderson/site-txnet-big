---
id: network
layer: domain
status: draft
version: 2
updated: 2026-09-27
---

# The reserve — a metered Grant's configs keep headroom the wallet backs

What governs the step after the split in `allocateCeilings` (F-027-cs,
ADR-0091 amendment 2026-09-27). Read it before changing how an idle config's
headroom is sized on a metered Grant, or before giving the reserve to a
prepaid one.

**Why it exists.** The split's floors come out of the bag, so they thin with
the config count: 100 inbounds on 1 GiB left each idle one 5.4 MB after a
re-split, and a first connect or a switch to a backup inbound was cut in under
a second. ADR-0091's floor holds only for a bag ≥ `2(N-1) × rate × 180 s`. A
metered bag is small by design (the horizon buys ~120 s ahead), so it is the
case this hurts most. A panel enforces its own client's figure, so N panels
cannot share one pool: a reserve every config can draw on has to be written
onto every one of them.

## Since F-027-dc: the reserve is part of Quota

The lease planner is the only writer of a ceiling (F-027-db), so the
per-config step below — billing's `allocateCeilings` — no longer reaches a
panel. The reserve now enters as a term of the planner's Quota:
`purchasedBytes + bytesAffordable(meteredRate, balance)`, read by
`network-service` itself ([contract.lease.md](contract.lease.md) rule 20).
The planner splits it like the bag, so `Σ ceilings ≤ Quota` holds with no
N × reserve on top, and its block request buys the bag back up before the
reserve is spent (rule 21). Rules 1 and 4 still hold; 2, 3, 5 and 6 describe
billing's split until F-027-dk retires it. The exposure below shrinks to one
reaction window of the whole wallet, not N of them.

## The rule (billing's split, until F-027-dk)

1. **Metered only.** The reserve is what the wallet would still buy
   (`bytesAffordable(meteredRate, balance)`, the shutdown extension's figure).
   A prepaid Grant has none: its bag is all there is, and `Σ ceilings ≤
   purchasedBytes` holds for it unchanged (user, 2026-09-27).
2. **Each config, after the split:** `ceiling = max(split, served + min(reserve,
   lineFloor))`, where `lineFloor` is ADR-0091's seconds of its own line (at
   least `DEFAULT_CONFIG_FLOOR_BYTES`; that floor where the panel declares no
   rate). It does not divide by N. The hot config gets it too, so its ceiling
   does not move between a bulk pass and a hot one.
3. **Only raises.** The split and `unallocatedBytes` are decided first, out of
   the bag; the reserve never takes from another config's share.
4. **A sub-account cap still wins** (F-608): the reserve stops at `dataCapBytes`.
5. **`Σ ceilings` may pass `purchasedBytes`** by up to N × the reserve. Each
   config alone is backed: one config drawing its reserve takes the Grant past
   its bag, which puts it inside the horizon, and the hot loop buys the block
   that covers it (`contract.hot-loop.md`).
6. **The shutdown figure is unchanged** and still never under the allocation
   (`config_wallet_backed_ceiling_extends`): `rebalance` floors it at the
   allocation, reserve included.

## What it costs

Several inbounds drawing at once on a nearly empty wallet can serve more than
the wallet buys. That gap is an overrun, and overrun is not charged
(`billing/contract.traffic-block.md`). The exposure is bounded by
`N × min(wallet, 180 s of line)` for one reaction window. A prepaid reserve was
rejected for exactly that reason: there, nothing would ever pay it back.
