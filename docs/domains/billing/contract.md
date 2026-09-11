---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-11
---

# Contract — billing

**One operation built** — the wallet credit/debit primitive (F-092-b, below).
Every other row in *Provides* is still intent from
`txnet-backend/prisma/domains/billing.prisma`.

## Request edge (built — F-092-a)

| What | Where |
|---|---|
| Every route is under `/api/billing/*`, published by Traefik behind `strip-fake-headers,my-auth` — the required gate | `dev-docker/docker-compose.main.yml` |
| A request without `X-User-Id`, `X-Tenant-Id`, `X-Role-Id` and `X-Session-Id` is refused **401** — never served with no tenant, never with half a set. `X-User-Permissions` may be empty or absent: an empty list | `billing-service/src/app/request/identity.middleware.ts` |
| The handler runs inside `runWithTenant({ id: X-Tenant-Id })`; `identityOf(req)` returns the rest. This service resolves no tenant itself | same file |
| Queries go through `PrismaService` on `DATABASE_APP_URL` with `withTenant` applied — no cross-tenant pool. `TENANT_SCOPED_MODELS` holds no billing model yet: the row that first queries one registers it | `billing-service/src/app/prisma/prisma.module.ts` |
| Success and errors use the `shared-core` envelope, translated per `Accept-Language` | `billing-service/src/main.ts` |
| `GET /api/health` bypasses the identity check and is not published by Traefik | `billing-service/src/app/health.controller.ts` |

## Wallet ledger (built — F-092-b)

`WalletLedgerService.credit(tx, entry)` / `.debit(tx, entry)` in
`billing-service/src/app/wallet/wallet-ledger.service.ts`; no route calls it yet
(F-092-i, F-092-j, F-092-m will).

| Rule | Why |
|---|---|
| Takes the caller's `tx`, which must come from `tenantTransaction(prisma, fn)`; `walletTransaction` is a registered model, so any other transaction is refused | the balance and the reason it moved commit together (`tenant-context` rule 5) |
| `entry.userId` must come from a tenant-scoped source — `X-User-Id`, or a row read under the scope | `wallet` has no `tenantId`; the ledger row is stamped with the tenant in scope |
| `amount` is base currency, `> 0`, at most 2 decimal places; anything else is `InvalidLedgerAmount`, never rounded | invariant 2; `Decimal(18, 2)` would round the amount but not `balanceAfter` |
| `cachedBalance` is updated with `where { id, version }` **before** the row is appended; `count = 0` is `WalletVersionConflict` | invariants 1, 4 — a loser appends nothing |
| A lost race is thrown, not retried; the caller restarts its whole transaction | a retry inside the same transaction cannot read the row fresh |
| A debit below zero, or from a user with no wallet, is `InsufficientFunds` | a missing wallet is a zero balance |
| A first credit opens the wallet (`createMany … skipDuplicates`) | two first credits meet at the version guard, not at the unique `ownerUserId` |
| Returns the appended `wallet_transaction`, whose `balanceAfter` is the new balance | — |

The errors are plain classes with English messages (C-01); the route that first
exposes one maps it to an i18n key.

## TL;DR

One `Wallet` per user; `cachedBalance` is a cache, `WalletTransaction`
(append-only) is the truth (ADR-0002). Payments come in through a
`PaymentGateway` (platform brand only) with two confirmation defences (webhook +
reconciliation worker) plus manual admin fallback. Coupons use a two-phase
reserve/confirm state machine.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| credit / debit wallet — **built**, see above | tx, userId, amount, reasonType, referenceId | `wallet_transaction` + new `balanceAfter` | sync tx | insufficient funds, version conflict, invalid amount |
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
