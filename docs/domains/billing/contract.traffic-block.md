---
id: billing
layer: domain
status: active
version: 5
updated: 2026-09-29
---

# The traffic block — bytes bought before they are served

What governs `BlockPurchaseService` (ADR-0072, F-027-q) and
`RemainderCreditService` (F-027-r): the only code that turns wallet balance into
bytes a metered Grant may serve, and the only code that gives the unserved ones
back. Read it before changing how a block is priced or refunded, or before
adding a second caller of either.

**No byte is served that has not been paid for.** The ceiling written to a
panel is bounded by `grant.purchasedBytes` (F-027-s), and this is the only
writer of that column that moves money. The other is an admin's gift (below). Nothing here reads the catalog: the price comes from
the Grant's `vpn.traffic` `grant_meter` (`vpn-meter.ts`, F-118-l) — its
`unitPrice` per 2^30 bytes, debited in its `currencyCode` — locked at issue
(ADR-0073), so a rate change never reprices a block already bought. Its
`billed` is the money cursor; a Grant with no such meter (a package plan) is
`grant_not_metered`, a postpaid one `grant_postpaid`.

## The call

In-process only, inside `billing-service`. `purchase(tx, input)` runs in the
caller's transaction — the block request's, or the Grant close's — and
`purchaseForGrant(input)` opens one for a caller with nothing else to commit.
Either way the transaction must come from `tenantTransaction`, because the
debit writes a registered model (`tenant-context/contract.md` rule 5).

| in | |
|---|---|
| `grantId` | the Grant the block is for. `active`, `metered`, with a rate |
| `targetBytes` | the headroom the caller wants covered — the lease planner's horizon (F-027-dc, below) |

| out | |
|---|---|
| `amount` | whole cents, exactly as the ledger took them |
| `bytes` | what those cents bought at this Grant's rate |
| `walletTransactionId` | the debit that paid for it |
| `purchasedBytes`, `billed` | the bag and the meter's money cursor as they now stand |

## Priced first, then converted

The block is sized **from its price, not from its bytes**. The target is
priced, the price is rounded **up** to a whole cent, and those cents are
converted back to bytes by integer division rounding **down**. So the block
covers the target, is never larger than what the debit bought, and no sub-cent
amount is ever computed — catalog §8.5's Redis accumulator has nothing to
accumulate, and `C-02` is untouched.

The arithmetic is integer `bigint` throughout, over the rate as an integer
number of `1e-8` dollars per 2^30 bytes. A `Decimal.div` would round at its own
precision and a floor taken afterwards could be one byte out, which is one byte
sold and not paid for.

`bytesAffordable(rate, balance)` is the same conversion with nothing debited:
what a balance would buy, rounded down. It bounds the ceiling a shutdown raises
a panel to (network `contract.resilience.md`, ADR-0078), and it answers an
unpriceable rate with **zero** rather than `rate_not_priceable` — the refusal
belongs on the path that moves money, and here it would fail the shutdown figure.

## Short balance buys a smaller block, not nothing

A balance that cannot fund the target buys the largest whole-cent block it can.
The balance is the free one, `cachedBalance - heldAmount` (F-118-a,
[contract.holds.md](contract.holds.md)), **plus the Grant's own VPN reserve
hold** (F-118-b, network `contract.reserve.md`): sized first, then the reserve
released, the block debited (one row) and the reserve topped back from what is
left, in the same transaction. Another Grant's reserve is never spent. The
exhaustion verdict reads the same figure, and a suspension releases the reserve.
A Grant with a spending cap is clamped to what the cap leaves too (F-118-i,
[contract.spending-cap.md](contract.spending-cap.md)), and each block is counted
on it in the same transaction.
Only a balance under one cent is refused (`insufficient_funds`), and then the
ceiling stays where it is and the panel cuts the user off by itself — ADR-0072's
worst acceptable failure. Stalling with 99c unspent is that failure arriving
early, so it is not a refusal.

## The reseller's side — a wholesale leg (F-118-n3)

On a meter with a wholesale leg (F-118-n2) the block is what **both** wallets
fund, the reseller prepaid whatever the user's mode (ADR-0105 (10), §14.5; a postpaid hold's growth too, F-118-n4, [contract.usage-rating.md](contract.usage-rating.md) rule 6).
`VpnWholesale` (`traffic/vpn-wholesale.ts`) raises `wholesaleBilled` to
`wholesaleConsumed` + the block's headroom, that only while the group holds a
platform panel (user, 2026-09-29); never down — a byte an own panel served funds the next.

1. **Bounded first.** The reseller's balance caps how far the bag may grow; a
   block rounding past it is re-sized a cent down. No room is
   `wholesale_unfunded`, short of funds (block request rule 3). The planner's reserve, and so the shutdown ceiling, holds the same `room` (`leaseplan.WholesaleRoom`, F-118-v).
2. **In the block's transaction**: one `metered_usage_charge`, `referenceId` the
   block's wallet row, the cursor guarded (`WholesaleCursorMoved` is `raced`).
3. **Settled at close, both ways** (F-118-y): `wholesaleBilled − wholesaleConsumed` priced down as `metered_usage_refund` against the Grant, on an admin's delete whatever it answered about the user's remainder;
   bytes served past the cursor (a platform panel added after the last block) charged as `metered_usage_charge` up to the reseller's balance,
   the rest logged and left below the cursor, never a negative wallet. `vpn-wholesale.spec.ts`.

## One transaction, both cursors

The debit, the bag and the meter's `billed` and `funded` commit together, so a
block billed and not granted — or granted and not billed — is not a reachable
state. All advance by the same figure, with `increment`, so nothing writes back
a number it read before the debit. The bag and `billed` are apart because their
**later** movements differ: the remainder credit below brings `billed` down at close,
and a written-off hold (ADR-0074) moves it alone too — neither touches what was
bought.

A purchase that raced another loses at `WalletLedgerService`'s version guard
(`WalletVersionConflict`) with nothing written — never with a block granted
against a balance already spent.

## What a block costs the ledger

Every block is a `traffic_consumption` row in the wallet ledger, and at a
two-minute horizon that is hundreds of rows a day for a heavy user. Two things
hold that down, and neither of them is a roll-up — the money has to move before
the bytes do, so there is no row to defer (ADR-0072).

- **The read side hides them by default.** `/wallet/history` answers every other
  reason type — `traffic_refund` included — unless the caller names traffic
  (`contract.history.md` rule 1). The ledger keeps every row; only the
  unnarrowed page is quieter.
- **The target carries a floor, and the floor is the caller's.** The block
  request carries the planner's measured rate, and floors the target at
  `MIN_BLOCK_SECONDS` (60) of it, so the write rate is bounded at the one place
  that knows the user's line rate. `purchase()` never clamps a
  target **up**: spending more of a wallet than was asked for is the caller's
  decision to make and not this service's, and a purchaser that quietly bought
  a bigger block would move money no ceiling had asked to cover.

Decided 2026-09-22 with the user (F-027-am), against sizing blocks larger here:
a floor on the price alone would not bound the row count — a 1 Gbit user spends
just as fast — and it would hold more of the wallet ahead of consumption, which
is ADR-0072's accepted cost and its revisit trigger.

## The remainder, given back at close

The other half of charging before serving (ADR-0072 rule 3, F-027-r).
`RemainderCreditService.credit(tx, {grantId})` runs in the closing
transaction — the same shape as the purchase — and gives back what a Grant
bought and never served. `creditForGrant` opens a transaction for a caller with
nothing else to commit. Only a **closed** Grant settles: `expired`, `cancelled`
and `exhausted`. A `suspended` one is revived by F-027-x/y with its ceiling
still standing, and a live one would buy the money back within minutes.

| | |
|---|---|
| what is unconsumed | the meter's `billed` − `grant.consumedBytes`, read after the reserve's release. A Grant reported **past** what it bought (ADR-0074) has a negative remainder and is refused, never refunded into the red — that gap is not charged by anything (user 2026-09-26: network `open-questions.md`, 2026-09-26 overrun row) |
| what it is worth | the remainder priced at the meter's `unitPrice` and rounded **down** to a whole cent — the exact mirror of the purchase's round up, so a refund never exceeds what the blocks cost. Sub-cent dust stays taken |
| what moves | one `traffic_refund` **credit**, `referenceId` the Grant, and the meter's `billed` down by the bytes those cents paid for. `purchasedBytes` never moves: it is what was bought, and it bounds the ceilings that were written against it |

**The money cursor is the record of the refund and its own guard.** After the
credit, `billed` sits at the consumed level, so a second close — a retried
sweeper, a cancel racing an expiry — computes dust and refuses
`nothing_to_credit`. That is the whole idempotency of this path; no column was
added to say a Grant was settled. The cursor is claimed **before** the credit is
written, under a `where` on the value that was read, so a block bought between
the two loses with nothing written (`cursor_moved`).

`traffic_refund` is its own reason, not a `traffic_consumption` row wearing the
other direction: that value is the one `/wallet/history` leaves out of a page
nobody narrowed (F-027-am), and money going **back** belongs on the page the
user reads without narrowing. It also comes off the reseller's sales figure —
`contract.revenue.md`.

Refusals, each writing nothing: `grant_not_found`, `grant_not_closed`,
`grant_not_metered`, `rate_not_priceable`, `nothing_to_credit`, `cursor_moved`.

**Two callers: an admin's delete** (entitlement F-311-m, `deleteGrant`), only when
the admin answers `refund`, and the close stage after the purge, always (F-118-x,
entitlement `contract.close.md`). `cursor_moved` rolls either one back.

**A prepaid Grant's remainder (F-311-m, user 2026-09-28).** `settle(tx, {grantId,
at, stoppedAt})` sends a prepaid Grant to `creditPrepaidRemainder`
(`traffic/prepaid-remainder.ts`, `prepaid-remainder.spec.ts`): both volume and
time were sold, so back comes `total × (1 − max(volume used, time gone))`,
rounded **down** to a cent — 30 days / 50 GiB for $10, deleted on day 12 with
10 GiB used, is $6.00. Volume used is Used / Quota; time gone runs from
`startsAt` to the delete, or to `stoppedAt` for a frozen Grant. Unlimited: time
alone; permanent: volume alone; both: `not_measurable`. Only what was paid: the
purchase invoice's `total` while `paid` — any other source or a free invoice is
`nothing_paid`. One `product_refund` credit against the invoice, which stays
`paid`; revenue nets it off the sale (`UNDOES`). Renewals record no price yet:
the one that does adds what it paid to this sum.

## An admin's gift — bytes nobody bought (F-311-l)

`giftGrantBytes(tx, grantId, {at, actorUserId, bytes, reason})`
(`traffic/gift-bytes.ts`) raises `purchasedBytes` by `bytes` and **leaves
the meter's `billed` where it is**; no wallet row is written. One `quota_adjustment`
row, source `admin_gift`, the admin and the reason. The planner sees a bigger
bag and buys no block until it is spent; the remainder credit gives back
`billed - consumedBytes`, so the gift is never in it — every byte served
counts against what was paid for first, and bytes unused at close are the
gift's before they are the wallet's. A Grant served past `billed` on a gift
is therefore normal, and its close refuses `nothing_to_credit` as the overrun
case does. A gift that leaves room revives a Grant suspended because its bag was
spent. Only an `active` or `suspended`, metered Grant: `grant_not_metered`,
`grant_closed`, `grant_not_active`; a block bought between the read and the
write is `grant_moved`. Route: [contract.reseller-grants.md](contract.reseller-grants.md).

## Refusals of a purchase

Each throws `BlockPurchaseRefused` and writes nothing: `grant_not_found`,
`grant_not_active` (a suspended Grant is revived by F-027-x/y first),
`grant_not_metered`, `target_not_positive`, `insufficient_funds`,
`block_below_one_byte` (a clamped block that buys no whole byte), `cap_reached`
(the wallet could fund it, the Grant's spending cap cannot — short of funds, as
the other two are), `wholesale_unfunded` (nor could the reseller's billing
wallet fund its side, F-118-n3 — short of funds too), `grant_postpaid` (a postpaid `vpn.traffic` card, F-118-k:
held and captured, never sold a block), and
`rate_not_priceable` — a zero rate, or one finer than `Decimal(18, 8)`. A free
byte is a catalog decision, not an arithmetic one, so a zero rate is refused
here rather than read as free traffic.

## Who asks for a block (F-027-dc, ADR-0093 amendment 2026-09-27)

`traffic/block-request.ts` is the only caller that buys a metered block. The
lease planner in `network-service` publishes `network.lease.block_request`
(`contracts/network/block-request.json`) when what a Grant bought runs out
inside its horizon; `BlockRequestQueue` (`traffic/block-request.queue.ts`)
routes it to `BlockRequestService` at prefetch one. The hot loop that bought
before it is deleted (F-027-dk).

1. **The bag it names is the guard.** It buys only while `purchasedBytes`
   still equals the message's; otherwise `stale`, nothing written. Two turns
   asking for one bag buy once.
2. **Skipped without a write**: a Grant not found, not metered or unlimited,
   not `active`, or a target of nothing after the floor.
3. **A short wallet is reported, not thrown**; when the bag is also spent,
   `suspendIfExhausted` is asked in the same transaction (F-027-x). A lost
   `WalletVersionConflict` is `raced`, and acked: the planner asks again.
4. **The planner's target includes any overrun.** It is a horizon of the rate
   less `purchasedBytes − Used`, so bytes served from the reserve past the bag
   are bought with the next block — from that reserve's held money if the free
   balance is short (F-118-b) — rather than left uncharged.
5. **A postpaid Grant is not sold a block** (F-118-k,
   [contract.usage-rating.md](contract.usage-rating.md) "VPN postpaid"): the
   same request, past the same guard and floor, captures what was served from
   its meter hold and holds the target on top (`VpnReserve.servePostpaid`). A
   wallet that cannot hold a cent is short, as rule 3 says; a capture that
   raced the hourly one is `raced`. The wallet-low notice reads the free
   balance it leaves.
6. **The balance a block leaves is read for the wallet-low notice** (F-601-g).
   `noticeLowBalance` (`traffic/low-balance.ts`) takes the debit's
   `balanceAfter` in the same transaction: under 1 GB at the Grant's rate it
   tells once per crossing, at or over it re-arms (entitlement
   `contract.retention.md` "Wallet low"). A refused block tells nothing here.
