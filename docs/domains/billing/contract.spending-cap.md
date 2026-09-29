---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-29
---

# Spending cap — one product, bounded by its owner

What governs a spending cap on one Grant (F-118-i, F-608, ADR-0105 (9)): the
sub-account. The owner holds a Grant for someone else — family, a friend, a
colleague — labels who it is for and bounds what its **usage** may cost. Read it
before changing any path that funds a Grant's usage (a block, a hold), or the
owner's routes below. It replaces `billing.sub_account`, a byte pocket on one
config that nothing wrote (dropped by migration
`20260929000700_a_spending_cap_bounds_one_product`).

Code: `billing-service/src/app/usage/cap-funding.ts` (the engine: `SpendingCaps`,
`withinCap`, `spendOnCap` — it imports nothing of this service, so the money
paths that call it and the routes that revive Grants form no cycle;
`traffic/reserve-load-order.spec.ts`), `spending-cap.ts` (`SpendingCapService`),
`spending-cap.controller.ts`, `spending-cap.schema.ts`. Proof: `usage/spending-cap.spec.ts`.

## The owner's routes

Behind the gate; whose Grant is `X-User-Id`. Another user's Grant, a closed
one (`expired`, `cancelled`) or a user with no wallet is `404
billing.grant.notFound`, like a missing id. Bucket `SPENDING_CAP` per user
(`SPENDING_CAP_RATE_LIMIT`). The writes are capability `account`.

| Route | Body | Returns |
|---|---|---|
| `GET /api/billing/traffic/grants/:grantId/cap` | — | `{grantId, cap}`; `cap` null when none is set |
| `PUT /api/billing/traffic/grants/:grantId/cap` | `{label, amount, period}` — label 1..40 characters, `amount` a decimal string > 0 with at most two places, `period` `none \| monthly`; anything else `400 billing.spendingCapInvalid` | `{grantId, cap}` |
| `DELETE /api/billing/traffic/grants/:grantId/cap` | — | `204`; no cap is `204` too |

`cap` = `{grantId, label, amount, currencyCode, period, periodStartsAt, spent,
held, left}`, money as two-place strings. `held` is what is promised to the
Grant now (its reserve and meters' holds); `left` = `amount − spent`, never
below zero.

## Rules

| Rule | Why |
|---|---|
| 1. **Funded to `min(free balance, amount − spent − held for it)`.** Every path that debits or holds for a Grant's usage asks `withinCap` first: the VPN block (`traffic/block-purchase.ts`), the VPN reserve (`traffic/vpn-reserve.ts`), a meter's prepaid block and postpaid hold (`usage/usage-settlement.ts`). *Held for it* is every open hold whose `ownerRef` is the Grant or one of its `grant_meter` rows; the hold being resized or spent is passed as `own` so it is not taken off twice | ADR-0105 (9): cut at whichever runs out first; a promise is spending the owner has already agreed to |
| 2. **`spent` moves with the charge.** Each usage charge — a VPN block, a meter's block, a capture — calls `spendOnCap` in the charge's transaction. A capture moves held money to spent, so the room does not change | the count and the ledger commit or roll back together |
| 3. **Only usage.** The plan's own price is paid at purchase and never counted; a Grant with no usage charges is bounded by nothing | ADR-0105 (9) |
| 4. **Reached, it cuts as an empty wallet cuts.** A block the wallet could fund and the cap cannot is refused `cap_reached` (a short-of-funds reason), so a spent bag suspends the Grant `quota_exhausted` (`suspendIfExhausted` reads the same bound). The owner's other Grants spend the rest of the wallet as before | one way to stop a Grant, one way back |
| 5. **Raised or removed, it comes back as a top-up brings it back.** The write runs `reviveFundedGrants` and tops the Grant's reserve in the same transaction; a top-up's revive also asks `withinCap`, so money arriving does not revive a Grant its cap still cuts. Lowered, the reserve past it is released at once; a postpaid meter's hold past it stays until its next capture or close | the owner sees the change on the next pass, not the next minute |
| 6. **`period`**: `none` is one budget for the Grant's life. `monthly` restarts on the cap's own start date, the day clamped to a short month (31 Jan -> 28 Feb), read lazily by the next funding decision and guarded on the period it read (open-questions 2026-09-29, ASSUMED). A new cap, or a changed `period`, counts from now; a changed amount or label keeps the count | no clock job; two decisions crossing the date restart it once |
| 7. **The wallet's currency.** Written in the wallet's `currencyCode`; a tenant's currency change converts `amount` (rounded, never below one minor unit) and `spent` (rounded down) with the wallet ([contract.currency-change.md](contract.currency-change.md)). A cap in another currency than its wallet funds nothing | C-02; rounding never shrinks the owner's room |
| 8. **One per Grant**, the Grant's tenant (`entitlement.same_tenant()`, strict RLS), deleted with the Grant | a Grant has one payer and one bound |

**The planner reads none of this.** The cap bounds the bag billing sells and the
hold it keeps, so it reaches the lease planner through Quota (network
`contract.reserve.md`), never per config.

**The panel:** the owner's form under a service's "manage" and held money
apart — panel-web [contract.spending-cap.md](../../interfaces/panel-web/contract.spending-cap.md) (F-118-j).

**Not yet:** bot screens, and a notice that says *cap* rather than *wallet* when a capped Grant
is cut (it is told `GRANT_WALLET_SPENT` today).
