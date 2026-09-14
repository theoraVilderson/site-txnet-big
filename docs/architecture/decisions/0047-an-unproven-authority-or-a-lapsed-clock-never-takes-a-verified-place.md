---
id: adr-0047
status: accepted
updated: 2026-09-14
---

# ADR 0047 — An unproven authority, or a lapsed clock, never takes a place that needs proof

- **Status:** accepted 2026-09-14 (rows F-092-ag, F-092-ah, F-092-ai)
- **Date:** 2026-09-14
- **Affects units:** billing

## Context

ADR-0046 shipped with two risks the user accepted, then asked to close:

- **A forged authority could take the real one's place.** A callback naming a
  payment by `?p=` whose verify met silence attached its authority to
  `gatewayTrackingCode` so the ladder had something to ask. Anyone holding the
  payment id could send a forged one during a gateway outage; it took the only
  slot, and the real authority then had to be attached by hand.
- **A coupon could pass its limit.** The expiry sweep released a payment's
  coupon holds when its clock ran out, but the bank can still charge it. A slot
  taken by someone else meanwhile left `usedCount` above `totalUsageLimit` when
  the late credit claimed it back (ADR-0046 decision 1).

Both have one root: something **unproven** — an authority nobody has
confirmed, a payment nobody has proved unpaid — was written where only proven
state belongs.

## Decision

1. **An authority met with silence is offered, not attached.**
   `payment_transaction.authorityCandidates` (`text[]`, at most
   `MAX_AUTHORITY_CANDIDATES` = 10) holds what a `?p=` callback brought when the
   gateway did not answer. Reconciliation (`verifyDue`, the ordinary scan and a
   person's inquire) asks about each candidate of a row with no authority:
   the first the gateway confirms at the row's amount is credited and attached
   in the crediting flip; one it disowns (`authority_invalid`,
   `amount_mismatch`, `payment_failed`, an inquiry `failed`/`reversed`) is taken
   back off with no log row, no flag and no close; silence keeps them all. The
   two proven ways — the gateway's unverified list matched by `p` and amount,
   and a person — still attach directly.
2. **The clock closes the payment, not its coupons.** The expiry sweep flips
   `pending` to `expired` and keeps the holds. A second pass releases them
   `expired` once the payment has been expired for
   `COUPON_HOLD_AFTER_EXPIRY_SEC` (default 3600), under a row lock that finds
   it still `expired`. A credit on an expired row confirms the holds it still
   keeps and claims back any already released; a reversal gives kept holds back
   `cancelled`.
3. **A coupon past its limit is announced.** `billing.coupons_over_limit()`
   (SECURITY DEFINER, a count only) feeds `billing_coupon_over_limit` on
   `postgres-exporter`; `BillingCouponOverLimit` fires when it is above zero.
   The claim without a limit check stays: refusing money already paid is still
   the worse error.
4. **A gateway's `failed` gives the coupons back at once.** Zarinpal's `failed`
   is final (the user checked): no charge can follow it. So an inquiry about a
   payment's **own** authority answering `failed` releases its holds
   `cancelled` in the log row's transaction, under the row lock, while the row
   is `pending` or `expired`. The payment stays open — invariant 9 still closes
   only on `reversed`. A `failed` about an offered authority releases nothing:
   it is not an answer about this payment.

## Consequences

- A forged flood during an outage costs at most ten gateway calls per retry and
  cannot block anything: the unverified list and a person still attach the real
  authority.
- An abandoned top-up holds its coupon slots for its TTL plus
  `COUPON_HOLD_AFTER_EXPIRY_SEC` instead of the TTL alone. A limited coupon runs
  out that much sooner under abandonment; the setting is the trade.
- Overflow is now possible only for a charge later than the grace, and is
  visible when it happens.
