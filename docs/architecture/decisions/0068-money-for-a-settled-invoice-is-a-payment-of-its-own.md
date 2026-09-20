---
id: adr-0068
status: accepted
updated: 2026-09-20
---

# ADR 0068 — Money that arrives for a settled invoice is a payment of its own

- **Status:** accepted 2026-09-20 with F-104-s (user)
- **Date:** 2026-09-20
- **Affects units:** billing

## Context
A provider invoice is not a payment. `nowpayments.provider.ts` says so in its
own rules — `expired` and `failed` are pending precisely because "one invoice
holds several payments (coin switched, re-deposit); closing on one would refuse
the one that pays". The first `partially_paid` nevertheless settles the row
`success` (F-104-d values what arrived), and every later IPN for the same
`invoice_id` then reached `deposit-webhook.service.ts`'s `if (!open) return;`.

That is a silent drop. The payer who sends the remainder, or pays the same
invoice again in another coin, has money in the merchant account and nothing in
the platform pointing at it: no credit, no log, no flag. Support cannot see it,
because there is nothing to see. The bug was found by review on 2026-09-16 and
left unfixed because the fix turns on a question a review cannot answer: whether
that money credits.

Crediting it into the original row is what the data model will not do. A
`payment_transaction` holds exactly one settlement — one `amountCredited`, one
`gatewayReferenceId`, one `amountReceivedMinor` — and `creditVerified` is a
`pending -> success` flip guarded on that status. A second settlement means a
second table and a rewrite of the settlement path.

## Decision
1. **The second arrival is a new `payment_transaction`,** for the same user at
   the same gateway under the same grant, settled through the one settlement
   path (`DepositFollowOnService`). The old row is never re-settled. The wallet
   ledger row, the `billing.payment.confirmed` event, the gateway settlement
   accrual and the panel's top-up history therefore need no new code and no new
   shape: they already read payments.
2. **The transfer's own reference is the follow-on's `gatewayTrackingCode`,**
   not the invoice's. Providers repeat deliveries — NOWPayments for days — and
   the reference is what tells a second payment from the first one told twice.
   `@@unique([gateway column, gatewayTrackingCode])` (ADR-0028) is the guard
   under the guard: a race between two deliveries is a refused write, which is
   read as the duplicate it is.
3. **It carries no coupon, and the fee comes out of it.** Credited is the
   arrival at the invoice's frozen rate, less the gateway's cut in the
   proportion that arrived — F-104-r's rule, applied to the charge rather than
   to `amountCredited`, because that figure carries the first payment's
   discount. A coupon applies only to a full payment; a follow-on buys none.
4. **The invoice's own rate values it.** The arrival is money for the price that
   invoice quoted. Every driver that settles by webhook charges the base
   currency (`chargesInBaseCurrency`, ADR-0019), so today that rate is 1 and the
   choice is observable only if a non-USD webhook driver is added — at which
   point this is the entry to revisit.
5. **What cannot be valued is flagged, never guessed.** No usable rate, a fee at
   or above the whole charge, an arrival worth under a cent, or a credit that
   did not take: a `payment_reconciliation_log` row on the **invoice** with
   `flagged_mismatch`, which is what that word already means here (F-092-l). A
   credited one is logged there too, `auto_confirmed`, naming the payment it
   grew — so the settled invoice is where a person finds either answer.

## Consequences
- A payer who underpays and then completes gets credited automatically, which
  is the outcome the platform was silently refusing.
- **`payment_transaction` grows rows no `start` ever wrote.** A row with no
  `returnOrigin`, an `expiresAt` already in the past and an authority that is a
  transfer id is a follow-on. Anything counting "top-up attempts" now counts
  these; the panel's history shows them as the credits they are.
- A follow-on stranded between its write and its credit (a crash in the window)
  is `pending` and already due, so the expiry sweep closes it — `creditVerified`
  accepts `expired`, so a later delivery still credits it.
- The reconciliation sweep is not involved and is not extended. This path is
  driven entirely by the provider's own repeated delivery, which is the only
  settlement NOWPayments offers (its `inquire` is `unavailable`).

## Alternatives considered
- **Log and flag only, credit by hand.** The conservative reading of the row's
  note, and rejected by the user on 2026-09-20: it is correct but it makes every
  completed underpayment a support ticket, and the platform grows resellers
  faster than it grows support.
- **A second settlement on the same row** (a `payment_settlement` table).
  Honest about what an invoice is, and a rewrite of the settlement path, the
  ledger's reference, the event's shape and the history page for a case one new
  row already covers. If a provider ever reports a *partial refund* of one
  transfer, this is the design to come back to.
- **Valuing the arrival at the live rate of the moment it lands.** Considered
  and dropped: it is identical for every driver that can reach this path today
  (they all charge the base currency), and it would make two payments for one
  invoice creditable at two different rates for no gain.
