---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-29
---

# Usage rating — a meter's usage becoming money

What governs `UsageSettlementService` (`usage/usage-settlement.ts`, F-118-g,
ADR-0105 (5)(6)(11)): the money side of `grant_meter`. Intake
([contract.metering.md](contract.metering.md) "Usage events") advances
`consumed`; this turns `consumed − billed` into ledger rows and says how far a
meter is `funded` — what its enforcer may serve (ADR-0105 (7)). Read it before
pricing a meter, before a second caller of any call below, or before F-118-h.

**A prepaid `vpn.traffic` is not here.** Its bytes keep the block purchaser
([contract.traffic-block.md](contract.traffic-block.md)) until F-118-l; every
call refuses it as `meter_on_its_own_path`. A **postpaid** one is (F-118-k,
"VPN postpaid" below). A package plan has no metered `grant_meter`, so nothing
here ever reads it (ADR-0105 (0)).

## The cursors

In the meter's unit, on `grant_meter`, each moved only by this service once
issue has written them at 0:

| cursor | means | moved by |
|---|---|---|
| `consumed` | units reported | intake only |
| `billed` | units whose money is settled — debited, captured, or the free included part | a block, a capture; brought down at a prepaid close by the credit |
| `funded` | units the enforcer may serve: prepaid, what blocks bought; postpaid, `billed` plus what the open hold covers | a block, a top-up, a close |

**The included quantity is free**: every figure is taken from
`max(cursor, includedQuantity)`, so the cursors jump over it and nothing
prices it. An `afterIncluded: stop` card sells nothing past it: a block or a
top-up is `not_metered_past_included`, and a close skips it.

Every cursor write is guarded on the `billed` and `funded` it read; a
settlement that raced another is `cursor_moved` with nothing written.

## Whole cents, in the buyer's favour

All arithmetic is `bigint` over the price in `1e-8` per `unitSize` (C-02, as
the block purchaser's; a zero price or one finer than `Decimal(18, 8)` is
`rate_not_priceable`).

| | rounding | then |
|---|---|---|
| a block (prepaid) | the target's price **up** to a cent, clamped to the free balance | buys the units its cents cover, **down**: covers the target, never more than paid |
| a hold (postpaid) | the target's price **up** to a cent, clamped to the free balance | `funded` = `billed` + the units the hold covers, **down** |
| a capture | `consumed − billed` priced **down** to a cent, never more than the hold | `billed` advances only by the units those cents cover; the rest is carried to the next capture, not charged and not lost |
| a prepaid remainder | `billed − consumed` priced **down** to a cent | `billed` down to `consumed`; sub-cent dust stays taken |

"The free balance" is bounded by the Grant's spending cap, if it has one, and
each block and capture is counted on it (F-118-i,
[contract.spending-cap.md](contract.spending-cap.md)).
A short balance buys a smaller block or holds less, not nothing; only under
one cent is `insufficient_funds` (a top-up that still has a hold is not
refused). At close, what is left under a cent of a postpaid meter is never
charged.

## The calls

In-process, each in the caller's `tx` from `tenantTransaction` (the ledger
writes a registered model). `ownerRef` of a meter's hold is the `grant_meter`
id, so two postpaid meters on one Grant hold apart.

| call | does | refuses |
|---|---|---|
| `buyBlock(tx, {grantId, meterKey, targetUnits})` | prepaid: `funded` and `billed` up by the block, then one `usage_charge` debit, `referenceId` the Grant | `wrong_mode`, `grant_not_active`, `target_not_positive`, `insufficient_funds`, `block_below_one_unit`, the ledger's own |
| `topUp(tx, {grantId, meterKey, targetUnits})` | postpaid: **captures first**, then holds up to the target's price and sets `funded` | `wrong_mode`, `grant_not_active`, `target_not_positive`, `insufficient_funds` |
| `capture(tx, {grantId, meterKey})` | postpaid: one `usage_charge` from the hold (`WalletHoldService.capture`); nothing due writes nothing | `wrong_mode` |
| `settleAtClose(tx, {grantId})` | every metered non-VPN meter of a Grant being closed: prepaid, one `usage_refund` credit of the remainder; postpaid, a capture, the hold released, `funded` down to `billed`. A second close moves nothing | — (the caller closes the Grant in the same `tx`) |

All refuse `grant_not_found`, `meter_not_on_grant`, `meter_on_its_own_path`,
`not_metered_past_included`, `rate_not_priceable` and `cursor_moved`, each
writing nothing (`UsageSettlementRefused`).

**Callers.** No non-VPN meter can be sold until its door exists (entitlement
`meter_not_served`): F-118-h's `authorize`/`commit` will buy blocks and top
holds up, and a Grant close call `settleAtClose`. Live today: the hourly sweep
below, and VPN postpaid's own paths (next section), which share these holds
through `PostpaidHolds` (`usage/postpaid-hold.ts`).

## The hourly capture

`captureDue()` behind `POST /api/internal/billing/usage/capture-due`
(`ServiceOnlyGuard`, raw `{scanned, captured, errors}`), asked by
worker-service's `usage_capture` at `5 * * * *` (automation
`contract.worker.md`). Hourly is ASSUMED (`open-questions.md` 2026-09-29).

1. Cross-tenant scan of active, postpaid, metered meters, `vpn.traffic`
   included (500 a call); those with `consumed` past `max(billed, included)`
   are due — a VPN one's `consumed` as the next section reads it.
2. Each in its own tenant transaction: capture, then the hold topped back to
   what it held before — the target is the hold, so a meter stays funded as
   far ahead as its caller last asked.
3. A lost race (`WalletVersionConflict`, `cursor_moved`) is the next hour's;
   anything else is logged and counted in `errors`. Safe to run twice: a
   capture leaves nothing due behind it.

## VPN postpaid (F-118-k, ADR-0105 (6)(7)(12))

A metered Grant sold on a postpaid `vpn.traffic` card (`vpnTrafficRateAt`
takes one per 2^30 bytes, nothing included, then metered; its rate is locked
as `meteredRate` too) is served on held money and charged after. The seller
picks the mode on the variant form from F-118-m (user, 2026-09-29).

1. **Its hold is its `grant_meter`'s** (`ownerRef` = the meter id), never the
   VPN reserve's, and it has no reserve beside it (network
   `contract.reserve.md`). `traffic/vpn-postpaid.ts` answers every
   `VpnReserve` call for it: a top holds the floor — `VPN_RESERVE_BYTES` at
   the rate — only when the hold is under it (no capture a minute); a release
   (suspension, freeze, cancel, close) captures, releases the rest, and
   brings `funded` down to `billed`.
2. **The bag is `funded`.** Every cursor move mirrors onto the Grant by the
   same delta — `billedBytes` by `billed`, `purchasedBytes` by `funded` — so
   the planner leases `billed` plus what the hold covers: the ceiling stands
   at what was consumed plus the held bytes.
3. **The planner's block request is a capture, then a hold**
   ([contract.traffic-block.md](contract.traffic-block.md) "Who asks"): what
   was served is captured, and the hold grows by the target's price on top of
   what is still held, never below the floor. No `traffic_consumption` is
   written; the block purchaser refuses it (`grant_postpaid`).
4. **`consumed` is the Grant's bytes less its gifts.** VPN bytes land on
   `grant.consumedBytes`, not on the meter (F-118-f), so `consumed` is read as
   `consumedBytes − (purchasedBytes − funded)`, floored at 0: an admin's
   gifted bytes (F-311-l) are served first and never charged.
5. **At close nothing is refunded**: `billed ≤ consumed`, so the remainder
   credit refuses `nothing_to_credit` after its release has captured.

Tests: `traffic/vpn-postpaid.spec.ts`.

## Reasons (ADR-0105 (11))

`usage_charge` — a debit and a sale (`IS_SALE`, [contract.revenue.md](contract.revenue.md));
`usage_refund` — a credit that undoes one (`UNDOES`). Both show on the
unnarrowed `/wallet/history` page ([contract.history.md](contract.history.md)).
`traffic_consumption` and `traffic_refund` stay for VPN's rows.

Tests: `usage/usage-settlement.spec.ts`.
