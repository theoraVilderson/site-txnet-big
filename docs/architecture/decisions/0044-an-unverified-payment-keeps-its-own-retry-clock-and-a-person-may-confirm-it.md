---
id: adr-0044
status: accepted
updated: 2026-09-14
---

# ADR 0044 — An unverified payment keeps its own retry clock, and a person may confirm it

- **Status:** accepted 2026-09-14, when F-092-x landed (rows F-092-x … F-093-o)
- **Date:** 2026-09-14
- **Affects units:** billing, automation, panel-web, identity (one permission)

## Context

A payer the bank charged can reach the callback while the gateway does not
answer `verify` — a timeout, a network error, a vault read that failed. The
callback already leaves that row `pending` (ADR-0028, "silence is not a
refusal"), but three things around it are wrong for the payer:

- **The panel says "failed".** `GATEWAY_CONNECTION_ERROR` renders on
  `/payment/failed`, so a payer whose money is safe pays again or opens a ticket.
- **The retry is late.** Only `deposit_reconciliation` asks again, and only once
  `expiresAt` (15 min) has passed; an `in_bank` answer then waits
  `RECONCILIATION_RECHECK_SEC` (6 h). The user's measured Zarinpal downtime is
  about a minute (2026-09-14).
- **Nobody can finish it by hand.** `ConfirmationSource.admin_manual` exists in
  the schema and nothing writes it. Legacy's operator topped the wallet up
  manually after checking Zarinpal's own panel — outside any audit trail.

## Decision

1. **"Verifying" is two columns, not a status.** `payment_transaction` gains
   `verifyAttempts Int @default(0)` and `nextVerifyAt DateTime?`. The row stays
   `pending`, so every status guard (ADR-0028 invariant 7) is unchanged; a
   non-null `nextVerifyAt` is what "verifying" means.
2. **Silence schedules a retry.** Wherever `verify` or `inquire` gets no
   settled answer, billing sets `nextVerifyAt` from a fixed ladder — 30 s, 1, 2,
   5, 10, 30 min, then hourly — and increments `verifyAttempts`. A settled
   answer (success, refusal, `reversed`) clears it.
3. **The retry is its own due-ness.** `deposit_reconciliation` takes a row whose
   `nextVerifyAt <= now` without waiting for `expiresAt` or the recheck window,
   and credits through `DepositSettlementService` as today (exactly once).
4. **The expiry job skips a verifying row.** Its coupon holds stay until a
   settled answer or a person closes it.
5. **After 24 h of retries the row is flagged for a person** and retries go on,
   hourly, until `RECONCILIATION_LOOKBACK_SEC`.
6. **A person may confirm a verifying or flagged payment** (`admin_manual`):
   permission `payment.confirm_manual`, scoped like `gateway.manage` — the
   platform owner any payment; a tenant only a payment on its own
   `tenant_gateway_config`, never one through a granted platform gateway. The
   route first inquires the gateway once; if that settles, the ordinary path
   runs. Only when it does not may the person credit with the gateway's
   reference number and a reason, written to `audit`.
7. **The panel names the state.** The callback redirects a verifying payment to
   `/payment/pending?t=` (signed as the other two, rule 10 of
   `contract.payment-result.md`); the top-up page warns and asks before a
   second payment while one is verifying (the user's choice, 2026-09-14).

## Consequences

- A payer never reads "failed" for a payment that may have been charged.
- Coupon capacity can be held for up to the lookback window by a payment
  nobody settles; a person closing it is the release.
- Telling the payer when a late credit lands needs an outbox consumer that does
  not exist; that is F-067-l, deliberately later (the user's choice).
