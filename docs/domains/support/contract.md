---
id: support
layer: domain
status: active
version: 2
updated: 2026-10-03
---

# Contract — support

Storage F-033-a, the user's routes F-033-b, attachments' reading side F-033-c;
the upload F-033-f, the agent side F-033-d, category admin F-033-e. Shape: [ADR-0112](../../architecture/decisions/0112-support-is-one-conversation-served-by-support-service.md).

## TL;DR

One `conversation` per support thread — tickets and live chat are its `mode`,
never two products (catalog §11.1). Append-only messages ordered by `seq`, a
read cursor per reader, attachments behind the storage port, categories per
tenant named per language. Served by `support-service` (`/api/support/*`).

## Provides

`support-service`, behind ForwardAuth. Any signed-in user; no permission. Each
route is the caller's own threads only (invariant 6) — another user's thread
answers exactly as a missing one.

| Route | Input | Output | Errors |
|---|---|---|---|
| `GET /api/support/categories` | `Accept-Language` | `[{id, key, name}]`: the tenant's active categories, else the platform defaults (ADR-0112 point 6) | — |
| `GET /api/support/conversations` | `?before=<nextBefore>&limit≤100` | `{items: [summary + unread], nextBefore}`, newest activity first | — |
| `POST /api/support/conversations` | `{body ≤4000, subject?, categoryId?}` | summary (`open`, `async`, `lastSeq` 1); subject = body's first line when absent | 404 `category_unknown`, 409 `too_many_unfinished` |
| `GET /api/support/conversations/:id/messages` | `?afterSeq=` or `?beforeSeq=`, `limit≤100`; neither = latest page | `{conversation, messages (oldest first, never internal, each with `attachments`), hasEarlier, lastReadSeq, seenUpToSeq}` | 404 `not_found` |
| `POST /api/support/conversations/:id/messages` | `{body ≤4000}` | `{id, seq, senderKind, mine, body, createdAt}` | 404 `not_found`, 409 `closed` |
| `POST /api/support/conversations/:id/read` | `{upToSeq?}` (body optional) | `{lastReadSeq}` — moves forward only | 404 `not_found` |

Status on a user's send (invariant 7): `open` while no agent has answered,
else `pending_agent`; a `resolved` thread reopens. Sending moves the sender's
own cursor to their message (replying is reading).

An attachment is `{id, fileName, contentType, sizeBytes, scanStatus, url,
urlExpiresAt}`. `url` is a path on the panel's own Host
(`/api/public/tenant/private-files/…`), minted on every read and valid five
minutes; it is `null` unless `scanStatus` is `clean` (invariant 9, ADR-0113). Rate limits per user:
`SUPPORT_READ_RATE_LIMIT`/min, `SUPPORT_OPEN_RATE_LIMIT`/hour,
`SUPPORT_SEND_RATE_LIMIT`/min; `SUPPORT_UNFINISHED_MAX` unfinished threads.

## Emits (events)

None yet.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`, tenant, permissions (forward-auth headers) | support blocked |
| object-storage | private files, `signedObjectUrl`, the scan port (F-033-c, ADR-0113) | attachments refused, text still works |
| locale-service | error messages, `Accept-Language` | envelope falls back to the key |

## Guarantees

- A conversation's history never moves between tables when its mode changes.
- A user never sees an agent's internal note (invariant 5).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| ticket / chat tables | 2026-10-03 | removed (empty) | `conversation` (ADR-0112) |
