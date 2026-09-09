---
id: adr-0028
status: accepted
updated: 2026-09-09
---

# ADR 0028 — A payment is credited once, keyed on the gateway's own code

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** billing, tenant

## Context

`billing.payment_transaction` has no idempotency column, and three different
paths can each claim the same payment: the gateway's webhook (which every
gateway retries, by design), a reconciliation job that re-reads the gateway's
records, and an admin resolving a stuck payment by hand.

Nothing prevents two of them from crediting the same wallet twice. The question
has been open since 2026-09-04 as blocking-because-money, and no payment code
is written yet, so the shape can still be chosen freely.

Two candidates: a unique constraint on the gateway's own tracking code, or an
idempotency key we mint ourselves and carry through the flow.

## Decision

**The gateway's tracking code is unique per gateway, enforced by the database**
— `@@unique([gatewayId, gatewayTrackingCode])` on `payment_transaction` — and
crediting a wallet happens in the same transaction that flips the transaction
row to its paid state, guarded by that row's current status.

A duplicate webhook therefore fails on the unique index or finds the row
already paid, and in both cases credits nothing. The guard is in Postgres, not
in service memory: a second replica processing a retry concurrently is exactly
the case an in-process check misses.

A key we minted ourselves was rejected because the duplicate does not originate
with us. The gateway is the party that retries, and the only identifier both
copies of a retry share is the gateway's.

## Consequences

- Every gateway driver must surface a tracking code that the gateway itself
  guarantees stable across retries. A gateway that does not have one cannot be
  integrated under this ADR without a new decision — that is deliberate, and it
  is better discovered while writing the driver than after a double credit.
- Reconciliation and admin resolution use the same write path; there is no
  second way to credit a wallet. ADR-0002's rule stands: a balance is never
  written outside a ledger-append transaction.
- The constraint is a migration on a table that has no rows today, so it costs
  nothing now and cannot be added quietly later — a duplicate already in the
  table would block it.
