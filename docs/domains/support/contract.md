---
id: support
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — support

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/support.prisma`.

## TL;DR

Tickets (`open` / `pending` / `closed`, priority, optional assigned admin) with threaded `ticket_message` + `ticket_attachment` (object storage). Separately, live `chat_session` + `chat_message` between a user and an admin.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| open ticket | userId, subject, priority | `ticket` (`open`) | sync | — |
| post ticket message | ticketId, senderType, body, attachments? | `ticket_message` (+ attachments) | sync | ticket closed |
| assign / set status | ticketId, adminId?, status | updated ticket | sync | — |
| start / send / close chat | userId / sessionId, body | `chat_session` / `chat_message` | sync | session closed |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`, admin identity + permissions | support blocked |
| audit | impersonation link when an admin acts via a ticket | link omitted |

## Guarantees (intended)

- Ticket + chat histories are retained after close/archive (chat via object-storage archive).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
