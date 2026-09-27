---
id: network
layer: domain
status: draft
version: 3
updated: 2026-09-27
---

# The reserve — a metered Grant's configs keep headroom the wallet backs

What governs the wallet's part of a metered Grant's Quota (F-027-cs, F-027-dc, F-027-dt,
ADR-0091 amendment 2026-09-27, ADR-0094 amendment). Read it before changing
how a metered Grant's headroom past its bag is sized, or before giving the
reserve to a prepaid one.

**Why it exists.** A split's floors come out of the bag, so they thin with the
config count: 100 inbounds on 1 GiB left each idle one 5.4 MB, and a first
connect or a switch to a backup inbound was cut in under a second. A metered
bag is small by design (a block buys ~120 s ahead), so it is the case this
hurts most.

## The rule

1. **Metered only.** The reserve is what the wallet would still buy
   (`bytesAffordable(meteredRate, balance)`, the shutdown extension's figure),
   shared between the owner's metered Grants (rule 5).
   A prepaid Grant has none: its bag is all there is, and `Σ ceilings ≤
   purchasedBytes` holds for it unchanged (user, 2026-09-27).
2. **It is a term of Quota, not a step per config.** The lease planner reads
   `purchasedBytes` plus its share of the reserve itself
   ([contract.lease.md](contract.lease.md) rule 20) and splits it like the bag,
   so `Σ ceilings ≤ Quota` holds with no N × reserve on top.
3. **The bag catches up.** A config drawing into the reserve takes the Grant
   inside the planner's horizon, and its block request buys the bag back up
   (rule 21, billing `traffic/block-request.ts`). A wallet that cannot is
   short, and a spent bag it cannot refill suspends the Grant (F-027-x).
4. **The shutdown figure is the share** (`walletBackedCeilingBytes`, the
   planner's since F-027-db), so it already holds the reserve
   ([contract.resilience.md](contract.resilience.md)).
5. **One wallet, one reserve** (F-027-dt, user 2026-09-27). The balance's
   whole cents are split evenly, floored, over every metered Grant of the
   owner the planner plans (`active`/`pending`, a locked rate, not unlimited),
   counted in the planner's load whether or not the turn touched it; each
   Grant buys its share at its own rate (`leaseplan.ReserveShare`). So the
   shares never buy past the balance, whatever the rates. A closed Grant still
   counts: the split never leans on another Grant's state, and a close is
   a spent Grant that a top-up may reopen (contract.lease.md rule 25). An even
   split, not one by demand: a busy Grant's share runs out first, its block
   request buys its bag back (rule 3), and the next turn reads the smaller
   balance — demand needs every Grant's rates in one turn, which no load has.

Billing's per-config step (`allocateCeilings`, `ceiling ≥ served + min(reserve,
lineFloor)` on every config) ran until F-027-db and was deleted in F-027-dk;
its `N × reserve` exposure went with it. A sub-account cap on the reserve went
with it too: see `open-questions.md` (F-608).

## What it costs

Configs drawing at once on a nearly empty wallet can serve more than the
wallet buys, inside one reaction window. That gap is an overrun, and overrun is
not charged (`billing/contract.traffic-block.md`). It is bounded by the whole
wallet once, not N times — once per owner, not once per metered Grant, since
F-027-dt (before it, each Grant leased the whole wallet). A prepaid reserve was rejected for exactly that
reason: there, nothing would ever pay it back.
