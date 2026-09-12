---
id: billing
layer: domain
status: active
updated: 2026-09-12
---

# Invariants — billing

From schema comments, plus 11 from the gift path (F-092-m). 1-4 are enforced by `WalletLedgerService` (F-092-b), 6 by coupon reservation (F-092-h) and gift redemption (F-092-m), 8 in part by the gateway port (F-092-f), 11 by `billing.redeem_gift_coupon`; the rest are not enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Wallet balance is never `UPDATE`d as a computation — only as a cache written together with an appended `wallet_transaction` (ADR-0002) | `WalletLedgerService` — the only writer of `cachedBalance` | silent money loss/gain |
| 2 | `wallet_transaction.amount` is always > 0; sign is carried by `direction` | `WalletLedgerService` refuses `<= 0` (`InvalidLedgerAmount`) | double-negative accounting bugs |
| 3 | Every balance-changing operation is a single Postgres transaction | `WalletLedgerService` writes only on the caller's `tenantTransaction` `tx` | partial writes, phantom balances |
| 4 | `cachedBalance` writes use the optimistic-lock `version` column | `WalletLedgerService` — `where { id, version }`, `count 0` throws | lost update under concurrency |
| 5 | Wallet transfer is atomic: sender debit + receiver credit in one tx, only after OTP confirm | planned service layer | money created/destroyed |
| 6 | A user never holds more live redemptions of a coupon than its `perUserUsageLimit` (`0` = unlimited) — counted in the reserving transaction, since the limit may exceed 1 (D-21) | `billing.reserve_coupon` counts it under a row lock on the coupon (F-092-h, ADR-0040), and `billing.redeem_gift_coupon` the same way (F-092-m); there is no DB unique | coupon abuse |
| 7 | A payment is credited to a wallet at most once regardless of confirmation source | schema: `gatewayTrackingCode` unique per gateway column, and exactly one gateway column set (ADR-0028, F-092-d); the status-guarded credit is F-092-j | double credit |
| 8 | `merchantId` / gateway secrets never default-selected or logged | a reseller's — and since D-25 the platform's — merchant id is read from the vault per call and never logged by a driver (F-092-f, `zarinpal.provider.spec.ts`); the deposit routes select explicit columns and never read `payment_gateway.merchantId` (F-092-s, `deposit-gateways.int.spec.ts`) | gateway takeover |
| 9 | Reconciliation never auto-reverses a credit, and never auto-closes one either; a mismatch is flagged for a human | `DepositReconciliationService` credits or writes `flagged_mismatch` and makes no other write to a payment (F-092-l, `deposit-reconciliation.service.spec.ts`) | wrongful clawback |
| 10 | All monetary columns are base currency only — no per-row currency column | schema (ADR-0002) | currency drift |
| 11 | A `coupon_redemption` row credits a wallet at most once: the wallet movement it caused names **it**, not its coupon, and both are written in one transaction | `billing.redeem_gift_coupon` takes the use and `WalletLedgerService.credit` stamps `referenceId` inside the same `tenantTransaction` (F-092-m) | a gift code spent for nothing, or credited twice |
| 13 | A granted gateway's collection is owed to the borrowing tenant exactly once: one `gateway_settlement_entry` per payment, written inside the transaction that credits the wallet | unique key on `paymentTransactionId` (F-096-a, `payment/gateway-grant-schema.int.spec.ts`); the accrual is F-096-d's | the platform owing the same money twice, to a tenant that can prove it once |
| 12 | A payment's `exchangeRateSnapshot` names the reading it came from: a rate read from the FX worker is stored with the `currency_exchange_rate` row's id, and a price quoted from a gateway's own `staticRate` stores neither | `priceAtGateway` returns `rate` and `rateSnapshotId` together and refuses a live rate with no snapshot id (F-0606-b, `gateway-pricing.spec.ts`); the column is a real FK, `ON DELETE RESTRICT` (`payment-schema.int.spec.ts`) | a rial invoice nobody can prove was priced correctly (ADR-0019) |

## How to test

Concurrent debit (version conflict): `wallet-ledger.spec.ts` against a fake
store, and `wallet-ledger.int.spec.ts` against a real Postgres under the app
role and RLS (`npm run test:int`). Duplicate gateway code and the one-gateway
CHECK: `payment/payment-schema.int.spec.ts`. The last coupon slot and the per-user
limit under a race: `payment/coupon/coupon-reservation.int.spec.ts`. The last gift code and
the per-user limit under a race, and the credit that commits with the use:
`payment/gift/gift-redemption.int.spec.ts`. The grant constraints and the
one-accrual-per-payment key (ADR-0041): `payment/gateway-grant-schema.int.spec.ts`. Still to write: transfer atomicity,
the status-guarded credit on a duplicate webhook.
