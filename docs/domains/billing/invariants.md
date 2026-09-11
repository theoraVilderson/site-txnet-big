---
id: billing
layer: domain
status: active
updated: 2026-09-11
---

# Invariants — billing

From schema comments. 1-4 are enforced by `WalletLedgerService` (F-092-b); the rest are not enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Wallet balance is never `UPDATE`d as a computation — only as a cache written together with an appended `wallet_transaction` (ADR-0002) | `WalletLedgerService` — the only writer of `cachedBalance` | silent money loss/gain |
| 2 | `wallet_transaction.amount` is always > 0; sign is carried by `direction` | `WalletLedgerService` refuses `<= 0` (`InvalidLedgerAmount`) | double-negative accounting bugs |
| 3 | Every balance-changing operation is a single Postgres transaction | `WalletLedgerService` writes only on the caller's `tenantTransaction` `tx` | partial writes, phantom balances |
| 4 | `cachedBalance` writes use the optimistic-lock `version` column | `WalletLedgerService` — `where { id, version }`, `count 0` throws | lost update under concurrency |
| 5 | Wallet transfer is atomic: sender debit + receiver credit in one tx, only after OTP confirm | planned service layer | money created/destroyed |
| 6 | `perUserUsageLimit = 1` coupons rely on the DB unique `(couponId, userId)` | schema `@@unique` | coupon abuse |
| 7 | A payment is credited to a wallet at most once regardless of confirmation source | planned idempotency key on `payment_transaction` | double credit |
| 8 | `merchantId` / gateway secrets never default-selected or logged | planned `select`/`omit` | gateway takeover |
| 9 | Reconciliation never auto-reverses a credit; mismatches are flagged for a human | planned reconciliation worker | wrongful clawback |
| 10 | All monetary columns are base currency only — no per-row currency column | schema (ADR-0002) | currency drift |

## How to test

Concurrent debit (version conflict): `wallet-ledger.spec.ts`, against a fake
store — not yet against a real Postgres. Still to write: transfer atomicity,
duplicate-webhook idempotency.
