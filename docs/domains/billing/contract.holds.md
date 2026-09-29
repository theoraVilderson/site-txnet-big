---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-29
---

# Wallet holds — money locked, not spent

What governs `WalletHoldService` (F-118-a, ADR-0105 (6)): money a wallet has
promised — a postpaid Grant's usage (F-118-g), the VPN reserve (F-118-b), a
per-use token (F-118-h) — taken out of what any debit may spend. Read it before
holding money, before adding a debit path, or before touching `heldAmount`.

**A hold is not a ledger row.** It moves no money and writes no
`wallet_transaction`. Money leaves a hold two ways: a **capture** turns it into
a ledger debit, a **release** gives it back to the free balance.

**Free balance** = `cachedBalance - heldAmount`. It is what every debit, block
and invoice is measured against. A user with no metered service holds nothing,
so every debit behaves exactly as before (ADR-0105 (0)): a package plan's path
never reads a hold.

## The calls

In-process, in shared-core `lib/billing/wallet-hold.ts` (billing's
`wallet/wallet-ledger.service.ts` re-exports it; `WalletModule` provides it).
Each takes the caller's `tx`, as the ledger does.

| Call | Does | Refuses |
|---|---|---|
| `hold(tx, {userId, ownerRef, amount, currencyCode})` | opens a hold for `ownerRef`, or tops up its open one; `heldAmount` up by `amount` | more than the free balance, or no wallet: `InsufficientFunds`; another currency: `LedgerCurrencyMismatch`; a bad amount: `InvalidLedgerAmount` |
| `capture(tx, {userId, ownerRef, amount, currencyCode, reasonType, referenceId?, tenantId?})` | the hold down by `amount` and `captured` up, then one ledger debit that lowers `cachedBalance` and `heldAmount` together (`WalletLedgerService.debitHeld`); returns the `wallet_transaction` | no open hold, or one smaller than `amount`: `HoldExceeded`; the ledger's own refusals |
| `release(tx, {userId, ownerRef, amount?})` | the hold and `heldAmount` down by `amount`, moving no money; with no `amount`, all of it and the hold is `closed` | no open hold, or less than `amount`: `HoldExceeded` |

## Rules

| Rule | Why |
|---|---|
| Every debit is bounded by the free balance: `WalletLedgerService` refuses the rest as `InsufficientFunds`, whatever the caller knows about holds. The block purchaser, the exhaustion verdict and the invoice's sufficiency read the free balance too | a purchase or a second meter must not spend what a hold promised (ADR-0105 context 1) |
| Postgres holds the same line: `CHECK (cachedBalance - heldAmount >= 0)` on `wallet` | a writer that is not the ledger is refused too |
| `heldAmount` is written only by `hold`/`release` and a capture's `debitHeld`, each under the wallet `version`, as `cachedBalance` is | every hold write on a wallet is serialised with every debit on it; a lost race is `WalletVersionConflict`, restart the transaction |
| `heldAmount` equals the sum of the wallet's open holds, all in its currency — a deferred constraint trigger checks it at commit | a `heldAmount` with no hold behind it is money locked for nobody |
| One open hold per `(wallet, ownerRef)` (partial unique index); a second `hold` tops it up. A closed hold is history: `amount = 0`, `closedAt` set (CHECK) | a Grant has one hold to settle against |
| A capture changes the balance and the hold by the same amount, so the free balance does not move | captured money was never spendable |
| A capture is guarded on the hold's `amount` it read; of two racing captures the second is `WalletVersionConflict` | the same held money cannot be captured twice |
| A hold is in the wallet's currency and never converted on the way in. A tenant's currency change converts open holds with the wallet, each **rounded down**, and `heldAmount` to their sum ([contract.currency-change.md](contract.currency-change.md)) | rounded down, the parts never exceed the rounded balance, and rounding only frees money |
| The VPN reserve (F-118-b) is one hold per metered Grant, `ownerRef` = the Grant id, sized by `VPN_RESERVE_BYTES` (`traffic/vpn-reserve.ts`): topped at issue, after a block, and on every way back to active (`purge.ts`'s revive, `unfreezeGrant`; the `reserve-due` sweep is the backstop); released by a suspension, a freeze, a cancel, a close, and by the sweep for a Grant no longer planned. Only its own Grant's block spends it (release, then debit). A **postpaid** VPN Grant holds none: its `vpn.traffic` meter's hold (`ownerRef` = the meter id) is topped, captured and released on these same paths instead (F-118-k, [contract.usage-rating.md](contract.usage-rating.md) "VPN postpaid") | the planner leases what it buys (network `contract.reserve.md`), so it must be money nothing else can spend |
| A spending cap (F-118-i) counts every open hold of its Grant — the reserve and each `grant_meter`'s — as promised, and nothing new is held past `cap − spent − held` ([contract.spending-cap.md](contract.spending-cap.md)) | a hold is money the owner already agreed the Grant may spend |
| A hold or a release writes `billing.wallet.changed` `{tenantId, userId}` (no transaction, no figure) in its `tx`, **at most once per `HELD_PUSH_EVERY_MS` (30 s) per wallet**: the slot is claimed on the wallet row `writeHeld` already locked (`wallet.heldPushedAt`, never under `version`), so racing replicas announce once. A capture writes none here — its ledger debit announces itself (F-118-o) | the VPN reserve is re-topped every minute; one event a minute per metered Grant would flood the outbox for a figure the panel re-reads anyway |
| A move inside the window is not announced; the panel shows it on the next event or read (`GET /wallet/history` answers `held` and `available`, F-118-j, [contract.history.md](contract.history.md)) | the payload carries no figure, so a skipped event loses nothing a later read does not bring |

`wallet_hold` has no `tenantId` and is reached through the wallet's owner, like
`wallet`: `userId` must come from a tenant-scoped source, as for the ledger.

Tests: `wallet/wallet-hold.spec.ts` (the service), `traffic/vpn-reserve.spec.ts` (the reserve), `wallet/wallet-ledger.int.spec.ts`
"held money" (the CHECK, the trigger and a capture on Postgres).
