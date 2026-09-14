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
this file owns the retry clock all three now read, and (with F-092-y, F-092-z)
the flag for a person and the manual confirmation.

## The retry clock (built — F-092-x)

`verify-retry.ts` in `billing-service/src/app/payment/deposit/`, over two
columns of `payment_transaction` (migration `20260914000100_payment_verify_retry`).

| Rule | Why |
|---|---|
| **"Verifying" is not a status.** It is a `pending` row whose `nextVerifyAt` is non-null; `verifyAttempts` (default 0) is the rung it last climbed | every guard ADR-0028 hangs off `status: pending` — the credit, `close()`, the expiry flip — stays exactly as it was (invariant 7) |
| The ladder is 30 s, 1, 2, 5, 10, 30 min, then hourly, indexed by the attempts **already made** (`verifyRetryDelaySec`) | the measured Zarinpal downtime is about a minute (2026-09-14); hourly after that so a gateway that stays down is not hammered |
| **Silence schedules.** At the callback: `unavailable`, `amount_mismatch`, an unreadable merchant id or any unexpected error. At reconciliation: an `in_bank` answer, and any inquire or verify that got no answer except `authority_invalid` | ADR-0044 decision 2. The callback's outcome code is still `GATEWAY_CONNECTION_ERROR` until F-093-l gives the panel a page for it |
| The schedule write is `updateMany({ id, status: pending, verifyAttempts: <read> })` and changes only the two columns | a callback and a sweep hearing silence together cannot both climb from one rung; a row settled in between is left alone |
| **A settled answer clears `nextVerifyAt`** and keeps `verifyAttempts`: the credit (`DepositSettlementService`), a stated refusal (`close()`), and at reconciliation `failed`, `reversed`, `authority_invalid` and a `flagged_mismatch` — the last in the same transaction as its log row | how many tries it took is part of what a person reads later; a mismatch is a person's question, not the ladder's |
| **The expiry sweep skips a verifying row**, in its scan and in its guard (`nextVerifyAt: null`) | ADR-0044 decision 4: the gateway may have the money, so the coupon holds stay until a settled answer or a person closes it |
| Scheduling on an `expired` row writes nothing — the guard is `pending` | an expired row is reconciliation's to ask about on its own window, as before |

**Not covered:** reconciliation does not yet *take* a row because
`nextVerifyAt` is due — it still waits for `expiresAt` and the recheck window,
so the ladder is recorded but only the callback's first silence sets it in
motion. That is F-092-y, which also flags a row after 24 h of retries.
