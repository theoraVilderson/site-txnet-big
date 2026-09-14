---
id: billing
layer: domain
status: active
version: 14
updated: 2026-09-14
---

# Contract — billing / a verifying payment

A topic file of `contract.md` (§10): what happens to a top-up the gateway met
with **silence** — charged, perhaps, but not confirmed. ADR-0044 is the why.
`contract.deposit.md` owns the callback, the expiry sweep and reconciliation;
this file owns the retry clock all three now read, the flag for a person
(F-092-y) and the manual confirmation (F-092-z).

## The retry clock (built — F-092-x)

`verify-retry.ts` in `billing-service/src/app/payment/deposit/`, over two
columns of `payment_transaction` (migration `20260914000100_payment_verify_retry`).

| Rule | Why |
|---|---|
| **"Verifying" is not a status.** It is a `pending` row whose `nextVerifyAt` is non-null; `verifyAttempts` (default 0) is the rung it last climbed | every guard ADR-0028 hangs off `status: pending` — the credit, `close()`, the expiry flip — stays exactly as it was (invariant 7) |
| The ladder is 30 s, 1, 2, 5, 10, 30 min, then hourly, indexed by the attempts **already made** (`verifyRetryDelaySec`) | the measured Zarinpal downtime is about a minute (2026-09-14); hourly after that so a gateway that stays down is not hammered |
| **Silence schedules.** At the callback: `unavailable`, `amount_mismatch`, an unreadable merchant id or any unexpected error. At reconciliation: an `in_bank` answer, and any inquire or verify that got no answer except `authority_invalid` | ADR-0044 decision 2. The callback then answers `verifying` → `/payment/pending?t=` (below) |
| The schedule write is `updateMany({ id, status: pending, verifyAttempts: <read> })` and changes only the two columns | a callback and a sweep hearing silence together cannot both climb from one rung; a row settled in between is left alone |
| **A settled answer clears `nextVerifyAt`** and keeps `verifyAttempts`: the credit (`DepositSettlementService`), a stated refusal (`close()`), and at reconciliation `failed`, `reversed`, `authority_invalid` and a `flagged_mismatch` — the last in the same transaction as its log row | how many tries it took is part of what a person reads later; a mismatch is a person's question, not the ladder's |
| **The expiry sweep skips a verifying row**, in its scan and in its guard (`nextVerifyAt: null`) | ADR-0044 decision 4: the gateway may have the money, so the coupon holds stay until a settled answer or a person closes it |
| Scheduling on an `expired` row writes nothing — the guard is `pending` | an expired row is reconciliation's to ask about on its own window, as before |

## Taking a due retry, and the flag for a person (built — F-092-y)

`DepositReconciliationService.reconcile`, over one more column —
`verifyFlaggedAt` (migration `20260914000200_payment_verify_flag`).

| Rule | Why |
|---|---|
| **Two scans, verifying first.** A `pending` row with `nextVerifyAt <= now`, an authority and inside the lookback is taken **without** `expiresAt` or the recheck window; the ordinary scan (`expired`, or `pending` past its clock with `nextVerifyAt: null`) gets the batch room left | ADR-0044 decision 3. The ladder already spaces the asks; a backlog of old rows must not starve a payer waiting out a one-minute outage |
| A due verifying row is credited, flagged, cleared or re-scheduled by exactly the F-092-l / F-092-x rules — nothing about the answer is new | one guarded settlement path (invariant 7) |
| **The flag:** where a retry is scheduled, the same transaction sets `verifyFlaggedAt = now` on a row created more than `VERIFY_FLAG_AFTER_SEC` ago (default 86400), guarded `pending`, still verifying, not yet flagged | ADR-0044 decision 5. Measured from `createdAt`: the first silence is at most the 15-min pending clock later, and no third column is needed |
| The flag is **history, never cleared**, and stops nothing: retries go on hourly until `RECONCILIATION_LOOKBACK_SEC`, after which the row leaves the scan, still verifying, for a person (F-092-z) | its holds stay held (ADR-0044 consequences); a person closing it is the release |
| The answer gains a sixth count, `flaggedForPerson`; `DepositReconciliationJob` logs it as a warning and keeps its five required counts | an older billing still answers a run the job understands |

**The cadence is the job's**, not the ladder's: `deposit_reconciliation` is
seeded `*/5`, so a 30 s rung is asked on the next tick. The ladder is a floor.

## A person confirms it (built — F-092-z)

`ManualConfirmController` + `ManualConfirmService` in
`billing-service/src/app/payment/deposit/`. Behind `payment.confirm_manual`
(`Admin` by migration `20260914000300_payment_confirm_manual` and `seed.js`;
SuperAdmin through `*`, ADR-0043). The permission is not the boundary.

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/payments/manual` | — | `[{id, tenantId, userId, source, gatewayId, gatewayName, providerName, amountRequested, amountCredited, chargedAmountMinor, authority, createdAt, verifyAttempts, nextVerifyAt, flaggedAt}]` — `pending` and verifying or flagged, oldest first, at most 200 |
| `POST /api/billing/payments/manual/:id/inquire` | — | `{paymentId, outcome, gatewayStatus, referenceId}` |
| `POST /api/billing/payments/manual/:id/confirm` | `{referenceId ≤64, reason 5..500}`, strict | the same shape |

`outcome`: `credited` / `already_settled` / `refused` / `mismatch` (the gateway
decided), `unsettled` (inquire only), `confirmed_manually` (confirm only).

| Rule | Why |
|---|---|
| **Scope like `gateway.manage`:** the platform owner any payment; any other tenant only a payment whose `tenantId` is its own, on a `tenant_gateway_config` it owns, with no `grantId`. Everything else — and a row with no `tenantId` — is **404** `payment_not_found`, the list filtered the same way | ADR-0044 decision 6: a platform gateway's money is in the platform's account, a granted one's in the lender's; a 404 confirms nothing |
| Eligible only while `pending` and verifying or flagged; otherwise **409** `not_verifying` | a closed payment is not a person's to reopen |
| **The gateway is asked first, every time** — `DepositReconciliationService.askOnce`, a run's own rules for one payment (credit, log row, retry clock, flag), inside the payment's tenant scope | "if that settles, the ordinary path runs" — a confirmed, refused or mismatched answer decides, and the person does not |
| Only `in_bank` or silence lets a person credit: `DepositSettlementService.creditVerified` with `admin_manual`, the gateway reference as `gatewayReferenceId`, `confirmedByAdminId`, `manualConfirmReason` — and the `payment_manual_confirm` / `payment` audit row (`tenantId` the payment's) **in the crediting transaction** | invariant 7: the same guarded flip, so a gateway answering a second earlier still credits once; a credit without its trail is what legacy did |
| `creditVerified` refuses `admin_manual` without the person, and a person on any other source | the enum and the columns cannot disagree |
| The amount is never a parameter: the credit is the row's `amountCredited` | a person confirms *that* it was paid, not *what* |
| Per user, per 900s: the list `PAYMENT_MANUAL_READ_RATE_LIMIT` (120), inquire and confirm `PAYMENT_MANUAL_WRITE_RATE_LIMIT` (30) | each write is a call to a bank |

## The payer watches it (built — F-093-l)

| Rule | Why |
|---|---|
| The callback's silence answers `{kind: 'verifying', paymentId}`, signed `{k:'v', p, e}` (`payment-result-token.ts`) and redirected to `RESULT_PATH.pending` | ADR-0044 decision 7: a payer never reads "failed" for a payment that may have been charged |
| `GET /api/billing/wallet/payments/:id` answers one `WalletPaymentRow` of **the caller's own** (`id` and `userId` together; anyone else's is **404**), per user `WALLET_PAYMENT_RATE_LIMIT` (300 / 900 s). Both payment routes carry `verifying` = `pending` and `nextVerifyAt` set | the page polls it every 10 s; its own bucket so polling never spends the financial page's |

## Paid after the clock ran out (built — F-092-aa)

ADR-0046 decision 1. `DepositSettlementService.creditVerified`, the callback,
and `billing.claim_expired_coupon_redemptions` (migration
`20260914000400_claim_expired_coupon_redemptions`).

| Rule | Why |
|---|---|
| **The flip tries `pending`, then `expired`**, two guarded `updateMany`s in the crediting transaction; `count: 0` on both is "already settled" | an outage longer than the 15-min clock expires the row before anyone hears the bank. Before this, reconciliation logged a paid expired payment "already settled" and never credited it |
| Which guard matched picks the coupon path: `pending` confirms the holds; `expired` **claims back** the uses the sweep released `expired` — `usedCount + n`, `reservedCount` untouched, **no limit check** | the payer was charged the discounted price. A coupon past its limit is visible; money refused over a counter is not recoverable by anyone |
| The callback verifies an `expired` row exactly like a `pending` one; only `failed` answers `VERIFICATION_FAILED` without asking. Silence on an expired row schedules nothing (the ladder guards `pending`) — reconciliation's ordinary scan owns it | reopening a `failed` row would overrule a stated refusal; an `expired` one was never refused |

