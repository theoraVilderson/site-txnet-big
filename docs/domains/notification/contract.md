---
id: notification
layer: domain
status: active
version: 2
updated: 2026-09-17
---

# Contract — notification

Runs in `notification-service` (ADR-0052). **Live since F-035-a:** a user's
in-app inbox. Campaigns (F-035-c/d) and delivery (F-035-e/f) are not built —
their tables exist, nothing reads or writes them.

## TL;DR

A user reads a page of their own `notification` rows with the unread count,
and marks some or all read. Another unit puts a row in a user's inbox through
the internal seam. Whose inbox is always the gate's `X-User-Id`.

## Provides

All routes under `/api`. Envelope, errors and 429 as every service (F-094).

| Operation | Route | Input | Output | Errors |
|---|---|---|---|---|
| read the inbox | `GET notifications` (gated) | `page`, `pageSize` (≤100, default 1/20), `unreadOnly=true\|false` | `{ items[], page, pageSize, total, unreadCount }`; item = `id, type, title, body, readAt, createdAt` (ISO), newest first | 400 `validation.failed`, 401 |
| mark read | `POST notifications/read` (gated) | `{ ids?: uuid[1..100] }` — absent = all | `{ marked, unreadCount }` | 400, 401 |
| create | `POST internal/notifications` (`SERVICE_AUTH_TOKEN`) | `{ userId, type, title ≤200, body ≤2000 }` | the item, 201 | 400; 404 on a missing or wrong token |

- `unreadCount` is over the whole inbox, whatever the page or filter.
- `marked` counts rows that changed. An id that is read already, does not exist
  or is another user's all count 0 alike — no route reveals another inbox.
- `title`/`body` are stored text: the caller renders the user's language first.
- Rate limits, per user, 15 min: `NOTIFICATION_READ` (300), `NOTIFICATION_WRITE`
  (120). The internal seam is not limited.

## Emits (events)

None yet. F-035-b pushes a new row to an open panel (outbox, ADR-0021).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| forward-auth | identity headers on gated routes | 401 |
| identity | `userId` (no FK across schemas; a caller names a real user) | — |
| automation | the worker for campaign fan-out (F-035-d, not built) | — |

## Guarantees

- `readAt` is written once, by the first mark-read (invariant 5).
- Campaign execution will be idempotent per `(campaignId, userId)` (F-035-d).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
