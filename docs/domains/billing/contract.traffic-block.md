---
id: billing
layer: domain
status: active
version: 3
updated: 2026-09-22
---

# The traffic block — bytes bought before they are served

What governs `BlockPurchaseService` (ADR-0072, F-027-q) and
`RemainderCreditService` (F-027-r): the only code that turns wallet balance into
bytes a metered Grant may serve, and the only code that gives the unserved ones
back. Read it before changing how a block is priced or refunded, or before
adding a second caller of either.

**No byte is served that has not been paid for.** The ceiling written to a
panel is bounded by `grant.purchasedBytes` (F-027-s), and this is the only
writer of that column. Nothing here reads the catalog: the price comes from
`grant.meteredRate`, locked at issue (F-027-p, ADR-0073), so a rate change
never reprices a block already bought.

## The call

In-process only, inside `billing-service`. `purchase(tx, input)` runs in the
caller's transaction — the ceiling allocator's, or the Grant close's — and
`purchaseForGrant(input)` opens one for a caller with nothing else to commit.
Either way the transaction must come from `tenantTransaction`, because the
debit writes a registered model (`tenant-context/contract.md` rule 5).

| in | |
|---|---|
| `grantId` | the Grant the block is for. `active`, `metered`, with a rate |
| `targetBytes` | the headroom the caller wants covered — the hot loop's horizon (F-027-u) |

| out | |
|---|---|
| `amount` | whole cents, exactly as the ledger took them |
| `bytes` | what those cents bought at this Grant's rate |
| `walletTransactionId` | the debit that paid for it |
| `purchasedBytes`, `billedBytes` | the cursors as they now stand |

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

## Short balance buys a smaller block, not nothing

A balance that cannot fund the target buys the largest whole-cent block it can.
Only a balance under one cent is refused (`insufficient_funds`), and then the
ceiling stays where it is and the panel cuts the user off by itself — ADR-0072's
worst acceptable failure. Stalling with 99c unspent is that failure arriving
early, so it is not a refusal.

## One transaction, both cursors

The debit and the two cursors commit together, so a block billed and not
granted — or granted and not billed — is not a reachable state. Both cursors
advance by the same figure, with `increment`, so nothing writes back a number it
read before the debit. They are separate columns because their **later**
movements differ: the remainder credit below brings `billedBytes` down at close,
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
- **The target carries a floor, and the floor is the caller's.** F-027-u sizes
  the horizon and is where a minimum block belongs, so the write rate is bounded
  at the one place that knows the user's line rate. `purchase()` never clamps a
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
| what is unconsumed | `billedBytes - consumedBytes`. A Grant reported **past** what it bought (ADR-0074) has a negative remainder and is refused, never refunded into the red — that gap is a debt the holds queue settles |
| what it is worth | the remainder priced at `grant.meteredRate` and rounded **down** to a whole cent — the exact mirror of the purchase's round up, so a refund never exceeds what the blocks cost. Sub-cent dust stays taken |
| what moves | one `traffic_refund` **credit**, `referenceId` the Grant, and `billedBytes` down by the bytes those cents paid for. `purchasedBytes` never moves: it is what was bought, and it bounds the ceilings that were written against it |

**The money cursor is the record of the refund and its own guard.** After the
credit, `billedBytes` sits at the consumed level, so a second close — a retried
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

**No caller yet.** The close that calls this is the expiry sweeper's and the
cancel path's, and neither is built; `GrantService.transition` has no caller
outside its own spec. A Grant closed today keeps its remainder until one lands.

## Refusals of a purchase

Each throws `BlockPurchaseRefused` and writes nothing: `grant_not_found`,
`grant_not_active` (a suspended Grant is revived by F-027-x/y first),
`grant_not_metered`, `target_not_positive`, `insufficient_funds`,
`block_below_one_byte` (a clamped block that buys no whole byte), and
`rate_not_priceable` — a zero rate, or one finer than `Decimal(18, 8)`. A free
byte is a catalog decision, not an arithmetic one, so a zero rate is refused
here rather than read as free traffic.
