---
id: network
layer: domain
status: draft
version: 4
updated: 2026-09-29
---

# The reserve — a metered Grant's configs keep headroom the wallet backs

What governs the wallet's part of a metered Grant's Quota (F-027-cs, F-027-dc, F-118-b,
ADR-0091 amendment 2026-09-27, ADR-0094 amendment, ADR-0105 (8)). Read it before changing
how a metered Grant's headroom past its bag is sized, or before giving the
reserve to a prepaid one.

**Why it exists.** A split's floors come out of the bag, so they thin with the
config count: 100 inbounds on 1 GiB left each idle one 5.4 MB, and a first
connect or a switch to a backup inbound was cut in under a second. A metered
bag is small by design (a block buys ~120 s ahead), so it is the case this
hurts most.

## The rule

1. **Metered only, and held money** (F-118-b, ADR-0105 (8)). The reserve is
   what the Grant's own open hold on the owner's wallet buys at its locked
   rate — its `vpn.traffic` `grant_meter`'s `unitPrice`, F-118-l —
   (`BytesAffordable(unitPrice, wallet_hold.amount)`, `ownerRef` = the
   Grant). Billing holds `VPN_RESERVE_BYTES` (default 1 GiB) at that rate,
   rounded up to a cent, clamped to the free balance — a fixed size so the
   rest of the wallet stays spendable (user, 2026-09-29). No hold is a reserve
   of nothing. A Grant with a spending cap (F-118-i, billing
   `contract.spending-cap.md`) holds no more than its cap leaves, so the cap
   reaches Quota here. A **postpaid** metered Grant (F-118-k) has none either:
   its hold belongs to its `vpn.traffic` meter, and billing writes what that
   hold covers into `purchasedBytes`, so its bag is already billed plus held
   bytes (billing `contract.usage-rating.md` "VPN postpaid"). A prepaid Grant has none: its bag is all there is, and `Σ
   ceilings ≤ purchasedBytes` holds for it unchanged (user, 2026-09-27).
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
5. **One Grant, one hold** (F-118-b; replaces F-027-dt's even split of the
   balance). Each reserve is money no other debit can spend — a purchase,
   another meter, another Grant's block (billing `contract.holds.md`) — so
   two Grants cannot lease the same money, whatever their rates. Billing
   (`traffic/vpn-reserve.ts`) tops it at issue, after every block and in the
   transaction of every way back to active (a top-up, a renewal, an
   unfreeze, a reseller's or bulk job's), and releases it when the Grant
   stops being planned (a suspension, a freeze, a cancel, a close). The
   minute's sweep (`vpn_reserve`) is the backstop: a deposit into a reserve
   held short, and any path that missed a write.
   The Grant's own block spends it first (billing `contract.traffic-block.md`),
   so bytes served from it are paid by the next block.
6. **No more than an even share of the wallet** (F-118-ag, live run
   2026-09-30). Where the wallet is smaller than the reserves together, the
   first Grant topped held all of it and the next held nothing: a second
   service stayed `pending`, and a capped one was cut as "top up" with 7.83
   in the wallet. Each Grant's headroom hold — a prepaid reserve, a postpaid
   floor — is bounded by `(free balance + the owner's headroom holds) ÷
   leased VPN Grants`, rounded down to a cent (`traffic/reserve-share.ts`).
   A Grant short of it, when it tops, buys a block or is revived, first
   **releases** every sibling prepaid reserve above the share — never spends
   it — and holds its own. A postpaid floor is counted, never released (part
   of it can be served and not yet captured). A wallet large enough for every
   reserve is untouched. The exhaustion verdict counts the share as the
   Grant's, so a cap that stops it reads `cap_reached`, not "top up".

Billing's per-config step (`allocateCeilings`, `ceiling ≥ served + min(reserve,
lineFloor)` on every config) ran until F-027-db and was deleted in F-027-dk;
its `N × reserve` exposure went with it. A sub-account cap on the reserve went
with it too: see `open-questions.md` (F-608).

## What it costs

A config can serve past its bag only as far as its Grant's hold buys, and
that money is locked, so the overrun `contract.traffic-block.md` once left
uncharged is paid by the block that follows. A smaller reserve than the old
whole-balance lease means thinner headroom for a Grant with many inbounds:
`VPN_RESERVE_BYTES` is the knob — one figure for the whole platform today.
A reserve held short on a low wallet grows back only at the next block or the
sweep, up to a minute after the deposit.
