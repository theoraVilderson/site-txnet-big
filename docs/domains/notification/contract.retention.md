---
id: notification
layer: domain
status: active
version: 7
updated: 2026-09-27
---

# Contract — notification: retention notices, once per Grant period

A §10 split of [contract.md](contract.md), which is at its ceiling. This is the
file a **producing domain** reads before it emits a retention event (F-601,
spec 9.5), and the file a later F-601 row reads before it adds one.

## Who does what (F-601-a, user 2026-09-27)

Spec 9.2: a domain emits, it never tells anyone. Retention notices travel the
one notice path of ADR-0084 — not a second one inside `notification-service`
(the user chose this over the row's first wording, 2026-09-27):

| Step | Where | What |
|---|---|---|
| emit | the producing domain (entitlement, billing, network) | an outbox row (ADR-0021) in the transaction that saw the moment |
| route | `worker-service` `RetentionNoticeConsumer`, queue `AUTOMATION_RETENTION_NOTICE_QUEUE` | bound to every type in `RETENTION_NOTICES` (`outbox/retention-notices.ts`) |
| once per period | **this unit**: `POST internal/notifications/retention/claim` | the ledger below; asked before anything is told |
| tell | `EventNoticeSender` -> auth-service `/internal/notify/user` | inbox (a `notification` row through this unit's `create`) and bot, in the user's language — [automation/contract.notices.md](../automation/contract.notices.md) |

## The claim

| Operation | Route | Input | Output | Errors |
|---|---|---|---|---|
| claim a notice for a period | `POST internal/notifications/retention/claim` (`SERVICE_AUTH_TOKEN`) | `{ eventId, userId, grantId: uuid, notice: <outbox type>, period: 1..100 chars }`, strict | `{ claimed }`, 200 | 400 `validation.failed`; 404 on a wrong token |

- One `retention_notice` row per `(grantId, notice, period)`. The first event
  to claim it writes it and is answered `claimed: true`.
- **The row is held by that event** (invariant 14): the same `eventId`
  claiming again is `true` — a send that failed after its claim is told on the
  redelivery — and any other event is `false`, which the consumer acks
  without telling anyone.
- A claim that was answered `true` and whose notice then never reached anyone
  is lost for the period. The consumer therefore validates the whole payload
  **before** it claims, and a failure after the claim dead-letters the event
  (F-067-d), where a replay under the same id is still owed.
- Not rate-limited, like every internal seam here.

## What a producer writes

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | the event key, `<domain>.grant.<moment>`; a row in `RETENTION_NOTICES` with its auth-service template, and `worker-service` in `OUTBOX_EVENT_BINDER` |
| `tenantId`, `userId`, `grantId` | yes | whose Grant — never looked up by the consumer |
| `period` | yes | the producer's name for the Grant's current period. **A renewal opens a new one** (the backlog row's rule), so the same notice may be told again after it; e.g. the period's start instant, ISO |
| the params its row names | yes | strings, passed to the template as they are |

The table starts empty: F-601-a is the path, and each producing row
(F-601-b..l) adds its type, its template and its producer together.

## Not built here

- Muting and quiet hours (F-601-m): they will be read at the claim, which is
  why the ledger is this unit's — ADR-0084's revisit trigger.
- Combining a usage and a time notice due the same day (F-601-f).
- Retention of ledger rows: one per Grant, notice and period, kept.
