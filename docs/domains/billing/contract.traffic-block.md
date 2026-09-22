---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-22
---

# The traffic block — bytes bought before they are served

What governs `BlockPurchaseService` (ADR-0072, F-027-q): the only code that
turns wallet balance into bytes a metered Grant may serve. Read it before
changing how a block is priced, or before adding a second caller of it.

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
movements differ: F-027-r credits the remainder back at close, and a written-off
hold (ADR-0074) moves the money cursor alone.

A purchase that raced another loses at `WalletLedgerService`'s version guard
(`WalletVersionConflict`) with nothing written — never with a block granted
against a balance already spent.

## Refusals

Each throws `BlockPurchaseRefused` and writes nothing: `grant_not_found`,
`grant_not_active` (a suspended Grant is revived by F-027-x/y first),
`grant_not_metered`, `target_not_positive`, `insufficient_funds`,
`block_below_one_byte` (a clamped block that buys no whole byte), and
`rate_not_priceable` — a zero rate, or one finer than `Decimal(18, 8)`. A free
byte is a catalog decision, not an arithmetic one, so a zero rate is refused
here rather than read as free traffic.
