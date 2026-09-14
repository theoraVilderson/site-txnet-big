---
id: adr-0045
status: accepted
updated: 2026-09-14
---

# ADR 0045 — The first outbox consumer dedupes in Redis, and notifies a user through auth-service

- **Status:** accepted (F-067-l)
- **Date:** 2026-09-14
- **Affects units:** automation, auth-api, redis-keyspace, realtime, panel-web

## Context

F-067-l tells a payer when a late credit lands (ADR-0044 consequences): a
`billing.payment.confirmed` outbox event whose `confirmationSource` is not
`webhook_auto` — reconciliation or a person credited it after the payer left.
It is the **first** consumer of the outbox, and `automation/contract.outbox.md`
deliberately left two things for that consumer to decide:

- **Where a consumer remembers an event it has handled.** Delivery is
  at-least-once (ADR-0021), so without a store the payer is told twice.
- **How a worker sends a bot message to a user by id.** Only OTP delivery does
  that today, inside `auth-service`'s senders, which own the tenant's bot
  clients and the user's linked chats.

## Decision

1. **Dedupe is Redis `SET NX` per consumer**, before any side effect:
   `outbox:processed:<consumer>:<eventId>` (`UnscopedRedisKeys.outboxProcessed`,
   C-03), TTL `RedisTtl.outboxProcessed` (7 days). A consumer whose side effect
   throws deletes its marker and rethrows, so the message dead-letters with the
   event still owed. No table, no migration (the user's choice, 2026-09-14).
2. **A user is messaged through `auth-service`**: `POST
   /api/internal/notify/user`, `ServiceOnlyGuard`, tenant from `X-Tenant-Id` —
   the OTP delivery seam's shape (F-067-a). It sends a named template, not text,
   in the user's `languagePreference`, to every verified linked chat whose
   platform has a usable tenant bot. No linked chat is a `200` with nothing sent.
3. **The live half rides the user's realtime channel** (`user:<userId>`,
   F-067-i) from `worker-service`'s `RealtimePublisher`, at most once, before the
   bot call. The panel's top bar already re-reads the balance on any event there.

## Consequences

- A duplicate is possible only after 7 days, or if Redis loses the marker —
  acceptable for a notification; a consumer that moves money must not copy this.
- The outbox relay has no seeded schedule: until an operator schedules
  `outbox_relay`, the event is never published and nobody is told.
- The next consumer reuses the key family with its own `<consumer>` segment.
