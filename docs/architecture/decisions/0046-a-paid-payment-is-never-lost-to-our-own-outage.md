---
id: adr-0046
status: accepted
updated: 2026-09-14
---

# ADR 0046 — A paid payment is never lost to our own outage

- **Status:** accepted 2026-09-14 (rows F-092-aa … F-093-o)
- **Date:** 2026-09-14
- **Affects units:** billing, automation, panel-web

## Context

ADR-0044 made silence a retry instead of a failure. Reviewing it against the
user's scenarios — our server loses the internet for 30 minutes; Zarinpal
times out for a minute or an hour; IDPay reverses a payment not verified within
20 minutes — found five gaps:

- **An expired row is never credited.** Reconciliation asks about `expired`
  rows, but `creditVerified` flips only `pending`, so a paid expired payment is
  logged "already settled" and the money is never credited. A callback lost to
  our own outage expires the row first, which is exactly the 30-minute case.
- **The ladder is not the cadence.** Due retries ride `deposit_reconciliation`
  (`*/5`), so a 30 s rung waits up to five minutes.
- **The callback can hang ~47 s** — three verify attempts at 15 s each — while
  the payer watches a blank tab.
- **A lost authority is lost for good.** `request` succeeded, the write of
  `gatewayTrackingCode` did not: no job can ask about the row and no screen
  shows it.
- **A gateway that reverses is not closed, and nobody is told.** Invariant 9
  forbids closing on any answer, so a `reversed` payment stays open, holding its
  coupons, and the payer is never told the bank is returning the money.

The user also wants to act on **any** open payment by hand — send a verify, or
confirm it when the verify path itself is broken — not only verifying ones.

## Decision

1. **`pending` or `expired` may be credited.** The guarded flip in
   `creditVerified` matches either. An expired row's coupon uses, released
   `expired` by the clock, are claimed `confirmed` in the same transaction
   (`billing.claim_expired_coupon_redemptions`) even past the coupon's limit:
   the payer paid the discounted price, and the discount is honoured. A callback
   on an expired row verifies it like a pending one.
2. **The callback has a budget** (`DEPOSIT_CALLBACK_VERIFY_BUDGET_MS`, default
   8000). A driver's retried call takes an optional deadline and stops at it;
   what is left is the ladder's.
3. **Due retries get their own job.** `deposit_verify_retry` (`always_on`, one
   tick = 60 s) calls `POST /api/internal/billing/deposit/verify-due`, which
   takes only verifying rows whose `nextVerifyAt` is due. Reconciliation keeps
   the ordinary scan and stops taking them.
4. **An authority can be found again, three ways.** The callback URL carries
   the payment id (`?p=`); a callback whose authority no row carries attaches it
   to that payment when the row has none. A provider may list its unverified
   payments (`listUnverified`, Zarinpal `unVerified.json`, last 100); a sweep
   attaches an authority whose `callback_url` names a row with none **and**
   whose amount equals `chargedAmountMinor`. A person may attach one by hand.
   Every attach is guarded `gatewayTrackingCode: null`, and the unique index
   (ADR-0028) refuses a second holder.
5. **`reversed` closes the payment.** Invariant 9 now reads: reconciliation
   never reverses a credit; it closes a payment only on the gateway's own
   `reversed`. The row becomes `failed` / `failureCode: reversed`, pending holds
   are released `cancelled`, and a `billing.payment.reversed` outbox event is
   written in the same transaction; F-067-m tells the payer. `failed` from an
   inquiry still closes nothing.
6. **A gateway declares its verify window.** `PaymentProvider.verifyWindowSec`
   — `null` for Zarinpal (the user checked: a paid payment is not returned), a
   number for a gateway that reverses. A verifying payment on a windowed gateway
   is flagged for a person at half the window instead of after a day.
7. **A person may act on any open payment.** `payment.confirm_manual` lists and
   acts on `pending` and `expired` rows inside the lookback, with or without an
   authority; the gateway is still asked first (ADR-0044 decision 6).

## Consequences

- A coupon can end with `usedCount` above its limit when a payment is credited
  after its clock. That is visible, and cheaper than refusing money already paid.
- A gateway driver added later must answer `verifyWindowSec`; the port makes
  forgetting it a type error.
- Matching an unverified list by amount alone is rejected: two payments of one
  amount would be indistinguishable. The payment id in the callback URL is what
  makes the match safe, so a row minted before F-092-ad can only be attached by
  hand.
