---
id: billing
layer: domain
status: active
version: 2
updated: 2026-09-29
---

# Usage rating — a meter's usage becoming money

What governs `UsageSettlementService` (`usage/usage-settlement.ts`, F-118-g,
ADR-0105 (5)(6)(11)): the money side of `grant_meter`. Intake
([contract.metering.md](contract.metering.md) "Usage events") advances
`consumed`; this turns `consumed − billed` into ledger rows and says how far a
meter is `funded` — what its enforcer may serve (ADR-0105 (7)). Read it before
pricing a meter, before a second caller of any call below, or before putting a
new meter behind the per-use door (below).

**A prepaid `vpn.traffic` is not here.** Its blocks are the block purchaser's
([contract.traffic-block.md](contract.traffic-block.md)), which moves its
meter's `billed` and `funded` itself (F-118-l); every call refuses it as
`meter_on_its_own_path`. A **postpaid** one is (F-118-k,
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
| a closed Grant's last capture (expired, cancelled, exhausted) | `consumed − billed` priced **up** to a cent, never more than the hold; nothing used, nothing charged | `billed` to `consumed`: nothing is left to forgive (F-118-al). A suspension or freeze is not last: it rounds down and carries |
| a prepaid remainder | `billed − consumed` priced **down** to a cent | `billed` down to `consumed`; sub-cent dust stays taken |

"The free balance" is bounded by the Grant's spending cap, if it has one, and
each block and capture is counted on it (F-118-i,
[contract.spending-cap.md](contract.spending-cap.md)).
A short balance buys a smaller block or holds less, not nothing; only under
one cent is `insufficient_funds` (a top-up that still has a hold is not
refused). A closed Grant owes nothing under a cent: its last capture rounds up,
as a prepaid remainder keeps its dust (ADR-0105 (5), amended).

## The calls

In-process, each in the caller's `tx` from `tenantTransaction` (the ledger
writes a registered model). `ownerRef` of a meter's hold is the `grant_meter`
id, so two postpaid meters on one Grant hold apart.

| call | does | refuses |
|---|---|---|
| `buyBlock(tx, {grantId, meterKey, targetUnits})` | prepaid: `funded` and `billed` up by the block, then one `usage_charge` debit, `referenceId` the Grant | `wrong_mode`, `grant_not_active`, `target_not_positive`, `insufficient_funds`, `block_below_one_unit`, the ledger's own |
| `topUp(tx, {grantId, meterKey, targetUnits})` | postpaid: **captures first**, then holds up to the target's price and sets `funded` | `wrong_mode`, `grant_not_active`, `target_not_positive`, `insufficient_funds` |
| `capture(tx, {grantId, meterKey})` | postpaid: one `usage_charge` from the hold (`WalletHoldService.capture`); nothing due writes nothing | `wrong_mode` |
| `settleAtClose(tx, {grantId, refund?})` | the Grant's open per-use tokens cancelled first (`cancelOpen`, below), then every metered non-VPN meter of a Grant being closed: prepaid, one `usage_refund` credit of the remainder — none when `refund` is false; postpaid, a capture, the hold released, `funded` down to `billed`, whatever `refund` says. A second close moves nothing | — (the caller closes the Grant in the same `tx`) |

All refuse `grant_not_found`, `meter_not_on_grant`, `meter_on_its_own_path`,
`not_metered_past_included`, `rate_not_priceable` and `cursor_moved`, each
writing nothing (`UsageSettlementRefused`).

**Callers.** A non-VPN meter is sold only behind the per-use door (below;
any other is entitlement `meter_not_served`), which shares this arithmetic and
`PostpaidHolds` (`usage/postpaid-hold.ts`) with the hourly sweep and VPN
postpaid's own paths. Two Grant closes call `settleAtClose`: an admin's delete
(F-118-u, [contract.reseller-grants.md](contract.reseller-grants.md)), `refund`
the admin's answer — held money was never paid, so it is released even on a
no — and the close stage after the purge, `refund` always (F-118-x, entitlement `contract.close.md`).

## The hourly capture

`captureDue()` behind `POST /api/internal/billing/usage/capture-due`
(`ServiceOnlyGuard`, raw `{scanned, captured, errors}`), asked by
worker-service's `usage_capture` at `5 * * * *` (automation
`contract.worker.md`). Hourly is ASSUMED (`open-questions.md` 2026-09-29).

0. First, every per-use token past its `expiresAt` is expired (next section);
   the answer adds `expired`, and its failures count in `errors`.
1. Cross-tenant scan of active, postpaid, metered meters, `vpn.traffic`
   included and `DOOR_METERS` excluded — the door captures at each commit
   (500 a call); those with `consumed` past `max(billed, included)`
   are due — a VPN one's `consumed` as the next section reads it.
2. Each in its own tenant transaction: capture, then the hold topped back to
   what it held before — the target is the hold, so a meter stays funded as
   far ahead as its caller last asked.
3. A lost race (`WalletVersionConflict`, `cursor_moved`) is the next hour's;
   anything else is logged and counted in `errors`. Safe to run twice: a
   capture leaves nothing due behind it.

## VPN postpaid (F-118-k, ADR-0105 (6)(7)(12))

A metered Grant sold on a postpaid `vpn.traffic` card (`vpnTrafficRateAt`
takes one per 2^30 bytes, nothing included, then metered; its `grant_meter`
is its only rate, F-118-l) is served on held money and charged after. The seller
picks the mode on the variant form from F-118-m (user, 2026-09-29).

1. **Its hold is its `grant_meter`'s** (`ownerRef` = the meter id), never the
   VPN reserve's, and it has no reserve beside it (network
   `contract.reserve.md`). `traffic/vpn-postpaid.ts` answers every
   `VpnReserve` call for it: a top holds the floor — `VPN_RESERVE_BYTES` at
   the rate — only when the hold is under it (no capture a minute); a release
   (suspension, freeze, cancel, close) captures, releases the rest, and
   brings `funded` down to `billed`.
2. **The bag is `funded`.** Every `funded` move mirrors onto the Grant's
   `purchasedBytes` by the same delta (`billed` lives on the meter alone) — so
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
6. **A reseller's Grant buys its hold's growth wholesale first** (F-118-n4,
   ADR-0105 (10), §14.5 — the reseller's leg is prepaid whatever the user's
   mode). `PostpaidHolds.topUpTo` takes a `FundingLeg`: `VpnWholesale`'s room
   ([contract.traffic-block.md](contract.traffic-block.md) "The reseller's
   side") bounds how far `funded` may rise, the hold is priced **down** to
   fit it, and the rise is one `metered_usage_charge` (its own `referenceId`;
   the guarded `wholesaleBilled` is the guard) **before** `funded` moves. No
   room and no hold open is `wholesale_unfunded` — short, as
   `insufficient_funds` is, in the block request and swallowed by a top; a
   hold still open is not refused, it only stops growing. At close the unused
   wholesale comes back as a prepaid Grant's does.

Tests: `traffic/vpn-postpaid.spec.ts`, `traffic/vpn-postpaid-wholesale.spec.ts`.

## The per-use door (F-118-h, ADR-0105 (7))

`UsageDoorService` (`usage/usage-door.ts`) is the enforcer of every meter in
`DOOR_METERS` (`shared-core` `catalog/meter.ts`) — today `vpn.config.regenerate`.
A card on one is sold on any variant (catalog `rate_card_not_served`,
entitlement `meter_not_served` let it through). Its token is a
`usage_authorization` row ([data-model.md](data-model.md)).

| call | does | refuses |
|---|---|---|
| `authorize(tx, {grantId, meterKey, quantity, key, ttlMs?})` | expires this meter's overdue tokens, then funds `consumed + open tokens + quantity`: **the reseller first** — on a Grant with a wholesale leg, the units past `wholesaleBilled` bought on its `tenant_billing_wallet` at the locked rate (`metered_usage_charge`, `referenceId` the token) — then the user: nothing inside the included quantity or what `funded` covers; else prepaid, one block debited (`usage_charge`); postpaid, the meter's hold grown to the whole price. Answers `{token, quantity, status, expiresAt}` (10 min unless `ttlMs`) | `meter_not_on_door`, `quantity_not_positive`, `grant_not_active`, `not_metered_past_included` (a `stop` card), `insufficient_funds`, `wholesale_unfunded`, `key_reused`, the engine's own |
| `commit(tx, {token, quantity})` | `quantity` (0..authorized) recorded through `recordUsage`, source `billing.usage-door`, key the token id; postpaid captures it; then gives back | `token_not_found`, `token_settled`, `token_expired`, `over_authorized` |
| `cancel(tx, {token})` | records nothing; gives back | `token_settled` (a committed one) |
| `cancelOpen(tx, {grantId})` | a closing Grant's every open token cancelled, each as `cancel` (F-118-u); answers how many. Always given back: a token is not a remainder, and its expiry would give it back within the hour | the `cancel`'s own |

1. **Every refusal before the first write**, so a refused authorization
   leaves nothing — no token, no debit, no hold — even in a transaction the
   caller goes on with. The same `key` answers the same token.
2. **All or nothing.** A balance short of the whole price is refused, not
   served less: a use is not divisible the way bytes are.
3. **An open token reserves its `quantity`**, so two at once are each funded.
   A settlement is guarded on `status = open`.
4. **The give-back** after a commit, a cancel or an expiry brings each side
   down to what was used plus what open tokens reserve, priced **down**:
   prepaid, `usage_refund` with `billed`/`funded` down (`giveBackAbove`);
   postpaid, the hold released to that price and closed at nothing;
   the reseller, `metered_usage_refund` (`referenceId` the token) with
   `wholesaleBilled` down (`usage/usage-wholesale.ts`, apart because it moves
   the reseller's ledger, never a user's). Under a cent moves nothing; those units stay funded.
5. **The wholesale leg has no included part**: the package rate prices every
   unit, so a unit the user got free is still the reseller's (F-118-n1).
6. **Expiry**: at the next `authorize` on the meter, or the hourly sweep —
   so money can stay reserved up to the hour past `expiresAt`.

**The regenerate** (`traffic/config-actions.ts`): on a Grant sold with the
meter, a user's regenerate authorizes 1 before the write, commits after it,
and cancels when the write is refused; the per-config cap is not read or
spent (user, 2026-09-29). An admin's or the system's stays free. Refusals
reach the user as `regenerate_limit_reached` (a `stop` card) or
`regenerate_unfunded` (either wallet short).

Tests: `usage/usage-door.spec.ts`; the regenerate in `traffic/config-actions.spec.ts`.

## Reasons (ADR-0105 (11))

`usage_charge` — a debit and a sale (`IS_SALE`, [contract.revenue.md](contract.revenue.md));
on the reseller's ledger, `metered_usage_charge` and `metered_usage_refund` (tenant `contract.billing.md`);
`usage_refund` — a credit that undoes one (`UNDOES`). Both show on the
unnarrowed `/wallet/history` page ([contract.history.md](contract.history.md)).
`traffic_consumption` and `traffic_refund` stay for VPN's rows.

Tests: `usage/usage-settlement.spec.ts`.
