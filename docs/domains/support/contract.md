---
id: support
layer: domain
status: active
version: 2
updated: 2026-10-03
---

# Contract — support

Storage F-033-a, the user's routes F-033-b, attachments F-033-c (reading) and
F-033-f (upload); the agent side F-033-d, category admin F-033-e, presence and
hours F-033-g, SLA F-033-h. Shape: [ADR-0112](../../architecture/decisions/0112-support-is-one-conversation-served-by-support-service.md).

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
| `GET /api/support/conversations/:id/messages` | `?afterSeq=` or `?beforeSeq=`, `limit≤100`; neither = latest page | `{conversation, messages (oldest first, never internal, each with `attachments`), hasEarlier, lastReadSeq, seenUpToSeq, realtime: {channel, proof, expiresInSec} \| null}` | 404 `not_found` |
| `POST /api/support/conversations/:id/messages` | `{body ≤4000}` | `{id, seq, senderKind, mine, body, createdAt}` | 404 `not_found`, 409 `closed` |
| `POST /api/support/conversations/:id/attachments` | multipart: `files` (repeat, ≤`SUPPORT_ATTACHMENTS_PER_MESSAGE`, each ≤`SUPPORT_ATTACHMENT_MAX_BYTES`; PNG, JPEG, WebP, PDF), `body?` ≤4000 | the message, as `POST …/messages`, with its `attachments` | 404 `not_found`, 409 `closed`, 400 `empty_message`/`too_many_files`, 413 `file_too_large`, 415 `file_rejected`, 422 `file_infected`, 503 `scan_unavailable`, 409 `quota_exceeded` |
| `POST /api/support/conversations/:id/typing` | — | `{expiresInMs}` — published to the thread's readers, stored nowhere; repeat while typing | 404 `not_found`, 409 `closed` |
| `POST /api/support/conversations/:id/read` | `{upToSeq?}` (body optional) | `{lastReadSeq}` — moves forward only | 404 `not_found` |

Status on a user's send (invariant 7): `open` while no agent has answered,
else `pending_agent`; a `resolved` thread reopens. Sending moves the sender's
own cursor to their message (replying is reading).

An attachment is `{id, fileName, contentType, sizeBytes, scanStatus, url,
urlExpiresAt}`. `url` is a path on the panel's own Host
(`/api/public/tenant/private-files/…`), minted on every read and valid five
minutes; it is `null` unless `scanStatus` is `clean` (invariant 9, ADR-0113). Rate limits per user:
`SUPPORT_READ_RATE_LIMIT`/min, `SUPPORT_OPEN_RATE_LIMIT`/hour,
`SUPPORT_SEND_RATE_LIMIT`/min (attachments count as sends);
`SUPPORT_TYPING_RATE_LIMIT`/min;
`SUPPORT_UNFINISHED_MAX` unfinished threads.

Attachments (F-033-f, ADR-0113): every file is scanned before anything is
written — infected is refused, an unanswering scanner refuses too (retry
later). A user's files across all their conversations stay under
`SUPPORT_STORAGE_QUOTA_BYTES` (invariant 10). Files land private at
`support/<conversationId>/<attachmentId>.<ext>`; the client's file name is
only shown and offered as the download's name.

## Provides — the agent side (F-033-d)

`/api/support/agent/*`, behind ForwardAuth and `support.agent` (403 without).
An agent reaches **every** conversation of the caller's tenant and none of
another's (RLS, catalog §11.6) — another tenant's thread answers as a missing
one. `support.agent` and `support.manage` (settings: hours, SLA, categories)
are granted to `Admin`, `support.agent` alone to the `Support` template
(migration `20261003001300`, `auth-handler/configs/permissions.yaml`). Same rate-limit buckets as the user side,
keyed by the agent's id.

| Route | Input | Output | Errors |
|---|---|---|---|
| `GET …/agent/conversations` | `?view=pending\|live\|mine\|unassigned` (default `pending`), `after=<nextAfter>`, `limit≤100` | `{items: [summary + userId, assignedToUserId, firstResponseAt, resolvedAt, closedAt, unread], nextAfter}` — `urgent` first, then the longest waiting | — |
| `GET …/agent/conversations/:id/messages` | as the user's read | as the user's page, the conversation as above, each message with `internal` and `senderUserId`; notes included; `seenUpToSeq` is the user's cursor | 404 `not_found` |
| `POST …/agent/conversations/:id/messages` | `{body ≤4000, internal?}` | the message, with `internal`, `senderUserId` | 404, 409 `closed` |
| `POST …/agent/conversations/:id/assign` | `{assigneeUserId: uuid \| null}` | the conversation | 404 `not_found`, 404 `assignee_unknown` |
| `POST …/agent/conversations/:id/resolve` | — | the conversation (`resolved`) | 404, 409 `closed` |
| `POST …/agent/conversations/:id/close` | — | the conversation (`closed`) | 404 |
| `POST …/agent/conversations/:id/read` · `…/typing` | as the user's | as the user's, `readerKind`/`senderKind` `agent` | 404, 409 `closed` (typing) |

Views: `pending` = `open` + `pending_agent` (waiting on us); the other three
are the unfinished threads (`open`, `pending_user`, `pending_agent`) that are
`live`, assigned to the caller, or assigned to no one.

A **reply** takes the next `seq`, stamps `firstResponseAt` once, sets
`pending_user` (a `resolved` thread stays resolved — only the user reopens it)
and **claims an unassigned thread for the replier** (user, 2026-10-03); an
assigned one keeps its assignee. A **note** (`internal: true`) takes the next
`seq` and changes nothing else — no status, no `lastMessageAt`, no event.
`resolve` stamps `resolvedAt`; `close` stamps `closedAt` and is final. An
assignee is an active account of the caller's tenant whose role holds
`support.agent` (or `*`); anyone else is `assignee_unknown`.

## Emits (events)

Realtime, on `support:<conversationId>` (F-034, ADR-0114) — at-most-once
notices; the stored thread is the record (`?afterSeq=` after a gap). Subscribe
with the `realtime` proof from a read of the thread — the owner's, or an
agent's of the tenant; a signed-in socket only.

| `payload.kind` | When | Fields |
|---|---|---|
| `support.message` | a message is stored (text or files) | `conversationId`, `status`, `message` (a message view without `mine`) |
| `support.read` | a reader moved their cursor | `conversationId`, `readerKind`, `lastReadSeq` |
| `support.typing` | `POST …/typing` | `conversationId`, `senderKind`, `expiresInMs` |
| `support.status` | an agent resolved or closed it (F-033-d) | `conversationId`, `status` |

The actor is a kind, never an account. An internal note is never published here
(invariant 5).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`, tenant, permissions (forward-auth headers); an assignee's role grants (`identity.user` → `role_permission`, read under RLS) | support blocked |
| object-storage | private files, `signedObjectUrl`, the scan port (F-033-c, ADR-0113) | attachments refused, text still works |
| locale-service | error messages, `Accept-Language` | envelope falls back to the key |
| realtime | the `support:` family, Redis fan-out (F-034) | `realtime` is `null` / events dropped; the thread still reads |

## Guarantees

- A conversation's history never moves between tables when its mode changes.
- A user never sees an agent's internal note (invariant 5).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| ticket / chat tables | 2026-10-03 | removed (empty) | `conversation` (ADR-0112) |
