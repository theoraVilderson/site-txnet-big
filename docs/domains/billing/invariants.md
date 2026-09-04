---
id: billing
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — billing

**DRAFT** — from schema comments; not enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Wallet balance is never `UPDATE`d as a computation — only as a cache written together with an appended `wallet_transaction` (ADR-0002) | planned service layer + tx | silent money loss/gain |
| 2 | `wallet_transaction.amount` is always > 0; sign is carried by `direction` | schema intent | double-negative accounting bugs |
| 3 | Every balance-changing operation is a single Postgres transaction | planned service layer | partial writes, phantom balances |
| 4 | `cachedBalance` writes use the optimistic-lock `version` column | planned service layer | lost update under concurrency |
| 5 | Wallet transfer is atomic: sender debit + receiver credit in one tx, only after OTP confirm | planned service layer | money created/destroyed |
| 6 | `perUserUsageLimit = 1` coupons rely on the DB unique `(couponId, userId)` | schema `@@unique` | coupon abuse |
| 7 | A payment is credited to a wallet at most once regardless of confirmation source | planned idempotency key on `payment_transaction` | double credit |
| 8 | `merchantId` / gateway secrets never default-selected or logged | planned `select`/`omit` | gateway takeover |
| 9 | Reconciliation never auto-reverses a credit; mismatches are flagged for a human | planned reconciliation worker | wrongful clawback |
| 10 | All monetary columns are base currency only — no per-row currency column | schema (ADR-0002) | currency drift |

## How to test

To be written with the service. Minimum: concurrent debit test (version
conflict), transfer atomicity test, duplicate-webhook idempotency test.
