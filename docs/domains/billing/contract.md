---
id: billing
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — billing

**DRAFT — schema only.** `txnet-backend/billing-service` is an empty Nx
scaffold. Shapes below are intent from
`txnet-backend/prisma/domains/billing.prisma`.

## TL;DR

One `Wallet` per user; `cachedBalance` is a cache, `WalletTransaction`
(append-only) is the truth (ADR-0002). Payments come in through a
`PaymentGateway` (platform brand only) with two confirmation defences (webhook +
reconciliation worker) plus manual admin fallback. Coupons use a two-phase
reserve/confirm state machine.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| credit / debit wallet | userId, amount, reasonType, referenceId | `wallet_transaction` + new `balanceAfter` | sync tx | insufficient funds, version conflict |
| start payment | userId, gatewayId, amount, couponId? | payment intent + redirect / deposit address | sync | amount out of gateway range |
| confirm payment | gateway webhook / reconciliation / admin | wallet credit + `payment_transaction.status = success` | async | duplicate, mismatch (flagged) |
| initiate wallet transfer | senderId, receiverId, amount | `wallet_transfer_request` (`pending_otp`) | sync | — |
| confirm wallet transfer | transferId, OTP | atomic debit+credit, `confirmed` | sync tx | bad/expired OTP (5 tries -> cancelled) |
| redeem coupon | couponId/code, userId, orderRef | `coupon_redemption` (`pending`) + discount amount | sync | expired, over limit, out of scope |
| finalize coupon | redemptionId, paymentTxId | `confirmed` (or `expired`/`cancelled`) | sync | — |
| accrue affiliate commission | triggering paymentId | `affiliate_commission` (`pending`) | async | — |

## Emits (events)

None planned yet (no bus). Payment confirmation is expected to drive
`network` provisioning and `notification` — mechanism undecided.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `ownerUserId`, transfer sender/receiver, OTP for transfer confirm | transfer/credit blocked |
| catalog | `servicePlanId` / `categoryId` for coupon scope + order pricing | coupon scope check fails |
| currency | base-currency amounts only in; display conversion is currency's job | — |
| tenant | `tenantId` denormalized on `wallet_transaction` / `payment_transaction` for reporting | — |

## Guarantees (intended)

- All amounts are base-currency `Decimal`, always positive; direction is
  `credit` / `debit` (ADR-0002).
- Balance mutation = one Postgres transaction: append ledger row (with
  `balanceAfter`) + bump `cachedBalance` + `version`.
- Payment confirmation is idempotent across webhook / reconciliation / admin
  (`confirmationSource`); a mismatch is `flagged_mismatch`, never auto-reversed.
- `coupon_redemption` unique `(couponId, userId)` enforces `perUserUsageLimit = 1`
  at the DB.
- Crypto: `exchangeRateSnapshot` is frozen at intent time, never recomputed.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
