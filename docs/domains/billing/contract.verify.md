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
| **Two runs since F-092-ac.** `verifyDue` (`POST /internal/billing/deposit/verify-due`, job `deposit_verify_retry`, every tick) takes a `pending` row with `nextVerifyAt <= now`, an authority and inside the lookback, **without** `expiresAt` or the recheck window. `reconcile` takes the ordinary scan (`expired`, or `pending` past its clock with `nextVerifyAt: null`), after a verifying row only once its retry is `VERIFY_RETRY_STALLED_SEC` (600) overdue | ADR-0044 decision 3, ADR-0046 decision 3. On the `*/5` sweep a 30 s rung waited five minutes; the stall net keeps an unscheduled deployment from stranding a payer |
| A due verifying row is credited, flagged, cleared or re-scheduled by exactly the F-092-l / F-092-x rules — nothing about the answer is new | one guarded settlement path (invariant 7) |
| **The flag:** where a retry is scheduled, the same transaction sets `verifyFlaggedAt = now` on a row created more than `VERIFY_FLAG_AFTER_SEC` ago (default 86400), guarded `pending`, still verifying, not yet flagged | ADR-0044 decision 5. Measured from `createdAt`: the first silence is at most the 15-min pending clock later, and no third column is needed |
| The flag is **history, never cleared**, and stops nothing: retries go on hourly until `RECONCILIATION_LOOKBACK_SEC`, after which the row leaves the scan, still verifying, for a person (F-092-z) | its holds stay held (ADR-0044 consequences); a person closing it is the release |
| The answer gains a sixth count, `flaggedForPerson`; `DepositReconciliationJob` logs it as a warning and keeps its five required counts | an older billing still answers a run the job understands |

**The cadence is the job's**, not the ladder's: `deposit_verify_retry` is
seeded `always_on` (one tick = 60 s), so a 30 s rung is asked within a minute.
The ladder is a floor.

## A person confirms it (built — F-092-z)

`ManualConfirmController` + `ManualConfirmService` in
`billing-service/src/app/payment/deposit/`. Behind `payment.confirm_manual`
(`Admin` by migration `20260914000300_payment_confirm_manual` and `seed.js`;
SuperAdmin through `*`, ADR-0043). The permission is not the boundary.

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/payments/manual` | — | `[{id, status, tenantId, userId, source, gatewayId, gatewayName, providerName, amountRequested, amountCredited, chargedAmountMinor, authority, createdAt, verifyAttempts, nextVerifyAt, flaggedAt}]` — since F-092-af every `pending` or `expired` payment made inside `RECONCILIATION_LOOKBACK_SEC`, verifying or not, `authority` null or not; oldest first, at most 200 |
| `POST /api/billing/payments/manual/:id/inquire` | — | `{paymentId, outcome, gatewayStatus, referenceId}` |
| `POST /api/billing/payments/manual/:id/confirm` | `{referenceId ≤64, reason 5..500}`, strict | the same shape |
| `POST /api/billing/payments/manual/:id/authority` (F-092-af) | `{authority 1..64}`, strict | the same shape — the answer of the ask that follows the attach |

`outcome`: `credited` / `already_settled` / `refused` / `mismatch` (the gateway
decided), `unsettled` (inquire only), `confirmed_manually` (confirm only).

| Rule | Why |
|---|---|
| **Scope like `gateway.manage`:** the platform owner any payment; any other tenant only a payment whose `tenantId` is its own, on a `tenant_gateway_config` it owns, with no `grantId`. Everything else — and a row with no `tenantId` — is **404** `payment_not_found`, the list filtered the same way | ADR-0044 decision 6: a platform gateway's money is in the platform's account, a granted one's in the lender's; a 404 confirms nothing |
| Eligible while `pending` or `expired` — verifying or not (F-092-af, ADR-0046 decision 7); `success` or `failed` is **409** `not_open` | a payer in a hurry reaches a person before the jobs reach the payment; a settled payment is not a person's to reopen |
| `authority` attaches only to a payment with none — guarded `gatewayTrackingCode: null`; otherwise **409** `authority_present`, and one another payment holds is **409** `authority_taken` — then asks once, exactly as `inquire` | the third way back for a lost authority (ADR-0046 decision 4); a wrong one costs a refusal the gateway states, nothing more |
| **The gateway is asked first, every time** — `DepositReconciliationService.askOnce`, a run's own rules for one payment (credit, log row, retry clock, flag), inside the payment's tenant scope | "if that settles, the ordinary path runs" — a confirmed, refused or mismatched answer decides, and the person does not |
| Only `in_bank`, silence, or a payment with no authority to ask about lets a person credit: `DepositSettlementService.creditVerified` with `admin_manual`, the gateway reference as `gatewayReferenceId`, `confirmedByAdminId`, `manualConfirmReason` — and the `payment_manual_confirm` / `payment` audit row (`tenantId` the payment's) **in the crediting transaction** | invariant 7: the same guarded flip, so a gateway answering a second earlier still credits once; a credit without its trail is what legacy did |
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

## The callback's budget (built — F-092-ab)

ADR-0046 decision 2. `PaymentVerifyInput.deadlineAt`, honoured by
`ZarinpalProvider.retried`; set by `DepositCallbackService`.

| Rule | Why |
|---|---|
| The callback verifies with `deadlineAt = now + DEPOSIT_CALLBACK_VERIFY_BUDGET_MS` (default 8000), taken **before** the vault read | the driver's three attempts at 15 s held a payer's browser up to ~47 s; the vault read is part of that wait |
| A driver cuts each attempt's timeout to what is left, starts none at or past the deadline, and skips a pause that would reach it; all three end as `unavailable` | the one failure the callback already reads as silence, so the row becomes verifying and the payer lands on `/payment/pending` |
| Only the callback sets a deadline. Reconciliation and a person's inquire keep the driver's own attempts | nobody is waiting on a sweep, and a person asked for the full answer |

## A lost authority is found again (built — F-092-ad)

ADR-0046 decision 4. `payment-callback-url.ts`; `DepositStartService`,
`DepositCallbackService`, `DepositReconciliationService.recoverAuthorities`,
`ZarinpalProvider.listUnverified`. The third way, by hand, is F-092-af's.

| Rule | Why |
|---|---|
| Every callback URL a gateway is told carries `?p=<paymentId>`, added to the tenant's panel URL or a gateway's own `callbackUrl` (F-092-w: host, path and query kept) | `start` stores the authority only after the gateway answers; a write lost there leaves a paid payment no authority names |
| A callback whose authority no row carries reads the row `p` names — only one with **no** authority, `pending` or `expired`. It verifies the query's authority against the **row's** amount. Success attaches the authority **in the crediting flip** (guarded `gatewayTrackingCode: null`); silence **offers** it (F-092-ag, below) and schedules a retry | the payer's own redirect is the cheapest recovery there is |
| For such a row a stated refusal, or `Status` not `OK`, **writes nothing** and answers `TRANSACTION_NOT_FOUND` | an id typed into a URL must not close somebody else's payment |
| `reconcile` first looks, per merchant account, at open rows with no authority older than `AUTHORITY_RECOVERY_AFTER_SEC` (120) inside the lookback, and reads `listUnverified` once for them (Zarinpal `unVerified.json`: the last 100). An entry is attached only if its `callbackUrl` names **that** row **and** its amount is `chargedAmountMinor`; the run answers `authoritiesRecovered` | the amount alone confuses two payments of one price. A row minted before F-092-ad has no `p` and is a person's. A gateway with no list, or no answer, recovers nothing this run |
| Every attach is `updateMany({ id, gatewayTrackingCode: null })`; the unique index refuses an authority another payment holds | nothing overwrites an authority that arrived meanwhile (ADR-0028) |

## An offered authority waits for proof (built — F-092-ag)

ADR-0047 decision 1. `offerAuthority` / `withdrawAuthority`
(`payment-callback-url.ts`), `DepositReconciliationService.askCandidates`.

| Rule | Why |
|---|---|
| A `?p=` callback that met silence appends its authority to `authorityCandidates` — guarded `gatewayTrackingCode: null` and not already listed, at most `MAX_AUTHORITY_CANDIDATES` (10). Past the cap nothing is added; the retry is still scheduled | anyone with the payment id can offer one. Before, silence wrote it into `gatewayTrackingCode` and a forged one held the real one's place |
| `verifyDue` and the ordinary scan take a row with its own authority **or** a non-empty candidate list | a candidate nobody asks about recovers nothing |
| A row with no authority asks each candidate in order — inquire, then verify at `chargedAmountMinor`. The first confirmed is credited `reconciliation_auto` with the authority attached in the flip, and logged `auto_confirmed` | the same proof the row's own authority needs |
| A candidate the gateway disowns — `authority_invalid`, `amount_mismatch`, `payment_failed`, or an inquiry `failed` / `reversed` — is removed with `array_remove`, and **nothing else**: no log row, flag or close | an unproven authority is not evidence about this payment; a mismatch on it is another payment's |
| Any other failure, or `in_bank`, keeps every candidate and schedules the next ask (`unanswered`). All disowned answers `unaskable`, which lets a person confirm by hand | merchant-wide trouble says nothing about one authority |
| The unverified list (by `p` + amount) and a person still attach directly | both are proof already |

## The bank returns the money (built — F-092-ae)

ADR-0046 decisions 5, 6. `DepositSettlementService.closeReversed`,
`DepositReconciliationService`, `PaymentProvider.verifyWindowSec`.

| Rule | Why |
|---|---|
| An inquiry answering `reversed` — in a run, `verifyDue`, or a person's inquire — writes its log row **and**, in the same transaction, closes the payment: `pending` then `expired` guarded, `failed` / `failureCode: reversed`, `expiresAt` and `nextVerifyAt` null | the gateway is returning the payer's money; left open, the row held coupon slots and read "verifying" for a week |
| A pending row's holds are released `cancelled`; an expired row's were released by the clock | nothing timed out — the payment was refused after the fact |
| The same transaction writes `billing.payment` / `billing.payment.reversed`, payload `{tenantId, userId, paymentId, chargedAmountMinor, amountCredited, gateway}` | the payer's notice (F-067-m), and the money never moves without its event (ADR-0021) |
| An inquiry answering `failed` still closes nothing | the clock owns that; `failed` from an inquiry is not the bank returning anything |
| Every driver declares `verifyWindowSec` — `null` for Zarinpal, whose paid payments are not returned unverified. On a windowed gateway a verifying payment is flagged at `min(VERIFY_FLAG_AFTER_SEC, window / 2)` after it was made | a flag after a day is useless for a gateway that returns the money in 20 minutes; half the window leaves a person time to act |

