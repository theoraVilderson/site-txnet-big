---
id: billing
layer: domain
status: active
version: 5
updated: 2026-09-20
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

## Free-service codes (built — F-502-l-b, D-35)

Migration `20260915000200_gift_redeems_free_grant`; `GiftRedemptionService` with
`GrantService` (ADR-0049). Proved by `gift-redemption.int.spec.ts`.

| Rule | Why |
|---|---|
| A `free_grant` code is redeemed in the same box, under the same gates and row lock; the redemption is `confirmed` at 0 and `usedCount` moves | D-35: one box for every code that is not a discount |
| The function answers the coupon's `grantVariantId`; the service issues the Grant in the same transaction — `source = coupon`, `sourceReferenceId` = the redemption row — so a use and its Grant commit together | one cause, one Grant (entitlement invariant 7) |
| No wallet is opened or credited | a free service gives no money |
| The answer is `{kind: "free_grant", code, grant: {id, variantId, startsAt, endsAt, featureKeys}, subscriptionKey}`; the key is shown this once and only its hash is stored. A credit answers `{kind: "wallet_credit", code, credited, balance}` | the user's call, 2026-09-14 |
| A variant switched off after the coupon was made refuses the issue and rolls the use back (500) | an admin's broken coupon, never a user's mistake |

## Reissuing a lost key (built — F-502-p)

`GrantTokenController` beside the box, over `GrantService.rotateTokenForUser`
(`entitlement/contract.md`). A key is shown once and only hashed, so a key lost
to a mis-click was lost for good; this is the way back.

| Route | Body | Answers `data` |
|---|---|---|
| `POST /api/billing/gift/grants/:id/rotate-token` | none — the id is the path, the user is the gate's | `{grantId, subscriptionKey}` — the new key, shown this once |

| Rule | Why |
|---|---|
| The owner is the gate's user. There is no body, so there is no field that could name another one | the only thing this route protects |
| Another user's Grant, and one that does not exist, are one answer: **404**, `i18nKey` `errors.billing.grant.notFound`, `reason: grant_not_found` | told apart, the route answers whether a Grant id exists |
| Its own bucket, `GRANT_ROTATE_TOKEN`, default **5** per 900s; **429** past it | sharing `GIFT_REDEEM`'s would spend the box's tiny budget recovering the key the box just gave out. Owner-only, so it is no oracle — but each call destroys a working key, so it is still a security limit |
| Capability `subscriptionLink`, not `endUserDeposit` | it moves no money and what it mints is the `/sub` credential, so it is open exactly when `/sub` is: a suspended tenant's user recovers a key until the grace ends, a terminated tenant's does not mint one for a link that answers nothing |
| The rotation is one transaction of its own and the old key stops working in it | there is no window in which both keys open the link, and none in which neither does |
| The Grant's **status is not a gate** | the row's scope (2026-09-20): a token grants nothing on its own — `/sub` reads the Grant — so rotating a dead one mints a key that opens nothing rather than something it should not |

**Not covered:** a `/sub` link for the key (F-113, F-027); the panel showing it
(F-502-l-c) and its reissue button (F-502-q, built). Listing a user's own Grants
is F-502-r: the button above is reachable only while the key is on screen, so a
key lost after the modal closed has no way back until that route exists.
