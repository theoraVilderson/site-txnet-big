---
id: billing
layer: domain
status: active
version: 4
updated: 2026-09-12
---

# Contract — billing / gift code

A topic file of `contract.md` (§10): the one route that reads a coupon and
moves money in the same breath. Its consumer is the panel's gift modal
(F-093-g). The discount engine's two sections in `contract.md` are its mirror,
not its caller — neither calls the other.

## Route (built — F-092-m)

`GiftController` + `GiftRedemptionService` in `billing-service/src/app/payment/gift/`,
over `billing.redeem_gift_coupon` (migration `20260912000000_gift_code_redemption`).
Behind the gate like every billing route ("Request edge" in `contract.md`): the
user and the tenant come from its headers, never from the body.

| Route | Body | Answers `data` |
|---|---|---|
| `POST /api/billing/gift/redeem` | `{code}` — 1..64 chars, trimmed | `{code, credited, balance}` — `code` as stored, `credited` and `balance` base-currency decimal strings |

## Rules

| Rule | Why |
|---|---|
| A gift code **is** a coupon: `discountType = wallet_credit`, credited at its `discountValue`. There is no gift table | D-21 |
| The redemption row and the wallet credit are one Postgres transaction. The row is written `confirmed` at once — a gift holds nothing, because it waits for no payment | invariants 1-3, 11; legacy credited with a computed `$inc` after four separate steps |
| The credit goes through `WalletLedgerService.credit` with `reasonType = coupon_redemption` and `referenceId` = the **`coupon_redemption` row's id**, never the coupon's | a coupon may be redeemed again; a redemption row never is (invariant 11) |
| The code is trimmed, upper-cased and matched as the top-up box matches its codes (`normalizeCouponCodes`) | one code must not be two codes depending on which box it was typed into |
| Gates, under a `FOR UPDATE` on the coupon row and in this order: inactive / unknown / soft-deleted / another tenant's / a platform coupon not serving this tenant / targeted at someone else -> `not_found`; a discount coupon -> `not_a_gift_code`; `expiresAt` -> `expired`; `perUserUsageLimit` (`0` = unlimited) counted over live redemptions -> `per_user_limit_reached`; `usedCount + reservedCount` vs `totalUsageLimit` -> `capacity_reached` | the lock, and its order, are `reserve_coupon`'s — the last slot cannot be decided by a count read a moment ago (ADR-0040) |
| A refusal is **409**, one `i18nKey` per reason under `errors.billing.gift.*`, plus the machine-readable `reason`. It writes nothing | the request was well-formed; the code simply is not redeemable |
| A discount coupon typed here answers `not_a_gift_code`, and a gift code typed into the top-up box answers `not_a_discount` | each box names the other, so the panel can say where the code belongs |
| A coupon whose `discountValue` is not `> 0` in cents **raises**, and reaches the client as a 500 | an admin's broken row, never a user's mistake — telling the user their code is invalid would hide it |
| Per user, per 900s: `GIFT_REDEEM_RATE_LIMIT`, default **10**; **429** past it | a gift code is a bearer secret worth money and this route is the only thing that says whether one exists — an unlimited version is a code-guessing oracle |

**Not covered:** issuing gift codes (an admin surface, not built); a gift code
that buys a service rather than credit — `wallet_credit` always lands in the
wallet.
