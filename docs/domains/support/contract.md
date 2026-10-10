---
id: support
layer: domain
status: active
version: 5
updated: 2026-10-05
---

# Contract — support

Storage F-033-a, the user's routes F-033-b, attachments F-033-c (reading), F-033-f (upload), F-309 (bytes); the agent side F-033-d, category admin F-033-e, presence and
hours F-033-g, SLA F-033-h, notices F-033-i, canned replies F-033-j, auto-close/rating/reopen F-033-k; platform staff under consent F-033-l in [contract.operator.md](contract.operator.md). Shape: [ADR-0112](../../architecture/decisions/0112-support-is-one-conversation-served-by-support-service.md).

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
| `GET /api/support/conversations` (and `…/counts`, UX-1-v) | `?before=<nextBefore>&limit≤100`; `status` (comma-separated `ConversationStatus`), `q` (2–64, case-insensitive on the subject and non-internal bodies; `%`/`_` literal) | `{items: [summary + unread + lastLine], nextBefore}`, newest activity first; `lastLine` the newest non-internal message's first line, `null` for files only (UX-1-w); `…/counts`: `{open, pending_user, pending_agent, resolved, closed}` over the caller's own threads | 400 on a bad `status`/`q` |
| `POST /api/support/conversations` | `{body ≤4000, subject?, categoryId?}` | summary (`open`, `async`, `lastSeq` 1); subject = body's first line when absent | 404 `category_unknown`, 409 `too_many_unfinished` |
| `GET /api/support/conversations/:id/messages` | `?afterSeq=` or `?beforeSeq=`, `limit≤100`; neither = latest page | `{conversation, messages (oldest first, never internal, each with `attachments`), hasEarlier, lastReadSeq, seenUpToSeq, realtime: {channel, proof, expiresInSec} \| null}` | 404 `not_found` |
| `POST /api/support/conversations/:id/messages` | `{body ≤4000}` | `{id, seq, senderKind, mine, senderName, body, createdAt}` — `senderName` an agent's full name, else username, else `null` (F-033-q) | 404 `not_found`, 409 `closed` |
| `POST /api/support/conversations/:id/attachments` | multipart: `files` (repeat, ≤`SUPPORT_ATTACHMENTS_PER_MESSAGE`, each ≤`SUPPORT_ATTACHMENT_MAX_BYTES`; PNG, JPEG, WebP, PDF), `body?` ≤4000 | the message, as `POST …/messages`, with its `attachments` | 404 `not_found`, 409 `closed`, 400 `empty_message`/`too_many_files`, 413 `file_too_large`, 415 `file_rejected`, 422 `file_infected`, 503 `scan_unavailable`, 409 `quota_exceeded` |
| `GET /api/support/conversations/:id/attachments/:attachmentId` (F-309) | — | the file itself, outside the envelope (`Content-Disposition` with its name) — for a surface with no panel Host to spend `url` on (the bot); only a `clean`, unexpired file on a message the user sees | 404 `not_found` (anything else, a stranger's included) |
| `POST /api/support/conversations/:id/typing` | — | `{expiresInMs}` — published to the thread's readers, stored nowhere; repeat while typing | 404 `not_found`, 409 `closed` |
| `POST /api/support/conversations/:id/read` | `{upToSeq?}` (body optional) | `{lastReadSeq}` — moves forward only | 404 `not_found` |
| `GET /api/support/availability` | — | `{live, withinHours, agentsOnline, nextOpenAt}` — the wait notice (F-033-g) | — |

Status on a user's send (invariant 7): `open` while no agent has answered,
else `pending_agent`; a `resolved` thread reopens. Sending moves the sender's
own cursor to their message (replying is reading).

An attachment is `{id, fileName, contentType, sizeBytes, scanStatus, url,
urlExpiresAt, expired}` — `expired`: retention deleted the file, `url` always null (F-033-n, `contract.operator.md`). `url` is a path on the panel's own Host
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
| `GET …/agent/conversations` | `?view=pending\|live\|mine\|unassigned` (default `pending`), `after=<nextAfter>`, `limit≤100` | `{items: [summary + userId, assignedToUserId, assignedToName (F-033-q), firstResponseAt, resolvedAt, closedAt, unread, sla], nextAfter}` — `urgent` first, then the nearest `sla.dueAt` (stopped last), then the longest waiting | — |
| `GET …/agent/conversations/:id/messages` | as the user's read | as the user's page, the conversation as above, each message with `internal` and `senderUserId`; notes included; `seenUpToSeq` is the user's cursor | 404 `not_found` |
| `POST …/agent/conversations/:id/messages` | `{body ≤4000, internal?}` | the message, with `internal`, `senderUserId` | 404, 409 `closed` |
| `POST …/agent/conversations/:id/assign` | `{assigneeUserId: uuid \| null}` | the conversation | 404 `not_found`, 404 `assignee_unknown` |
| `POST …/agent/conversations/:id/priority` | `{priority: low\|normal\|high\|urgent}` | the conversation, its SLA recomputed (F-033-h) | 404 |
| `POST …/agent/conversations/:id/resolve` | — | the conversation (`resolved`) | 404, 409 `closed` |
| `POST …/agent/conversations/:id/close` | — | the conversation (`closed`; `closedAutomatically` false — the sweep's are true, F-033-k) | 404 |
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
assignee is an active account of the caller's tenant holding `support.agent` (or `*`) from any
source — role, live group, given key, not taken (F-033-s); else `assignee_unknown`.

## Live or async (F-033-g, catalog §11.2)

`live` while **at least one agent is online and the tenant is inside its
weekly hours**; `async` otherwise (user, 2026-10-03). `mode` is decided again
on every open, every user message (text or files) and every agent reply — a
note leaves it. Same thread, same history either way.

- **Presence** is a heartbeat: `POST /api/support/agent/presence {status:
  online|away}` (`support.agent`, every 30s while the panel is open) → `{status,
  expiresInSec}`; an agent is forgotten 90s after the last beat, at once on
  `away`. `GET /api/support/agent/presence` → `{online: [userId]}`. Redis only;
  Redis unreadable = no one online = `async`, never an error.
- **Hours**: one weekly schedule per tenant on its own wall clock
  (`tenant.timezone`, ADR-0108). `GET /api/support/settings/hours` → `{zone,
  intervals: [{weekday 0=Sun…6, startMinute, endMinute}]}`; `PUT` the same path
  `{intervals: [{weekday, start "HH:MM", end "HH:MM" (24:00 allowed)}]}` (≤28)
  replaces it whole — `support.manage`; 400 `hours_invalid` on an empty or
  overlapping interval. **`[]` = always open**: presence alone decides.
- `nextOpenAt` is when the schedule next opens; `null` while open or with no
  schedule (then "we answer as soon as someone is online").

## SLA (F-033-h, catalog §11.3, §11.5)

Two targets per priority — first response and resolution, in **working
minutes** of the tenant's schedule (none = the wall clock) — the platform's
defaults (urgent 30/240, high 60/480, normal 240/1440, low 480/2880) unless
the tenant set its own (user, 2026-10-03). Priority is set by an agent; it is
queue position and these targets, nothing the user sees (§11.5).

- Due times count from `createdAt`; resolution is pushed later by the working
  time its clock spent **stopped** — from an agent's reply until the user
  writes again, and while resolved. A note stops nothing.
- Recomputed on open, a user's message, an agent's reply, resolve/close and a
  priority change; a new target or schedule reaches a thread on its next write.
- `sla` on an agent's view: `{firstResponseDueAt, resolutionDueAt, dueAt (the
  clock running now, null while stopped), firstResponseBreached,
  resolutionBreached}` — breached = answered/stopped/settled (or now) past due.
- `GET /api/support/settings/sla` → `[{priority, firstResponseMinutes,
  resolutionMinutes, source: tenant|platform}]`, urgent first; `PUT` `{targets:
  [{priority, firstResponseMinutes, resolutionMinutes}]}` replaces the tenant's
  own whole (left out = platform's) — `support.manage`; 400 `sla_invalid` unless
  `0 < first ≤ resolution ≤ 43200` and each priority once.

## Auto-close, rating, reopen (F-033-k)

Days are the platform's **7 and 7** unless the tenant set its own (user,
2026-10-03): `GET /api/support/settings/lifecycle` → `{autoCloseAfterDays,
reopenWithinDays, source: tenant|platform}`; `PUT` `{autoCloseAfterDays: 1–90
| null, reopenWithinDays: 0–90 | null}` (`support.manage`; both `null` = the
platform's again; else 400 `lifecycle_invalid`).

- **Auto-close.** `pending_user` or `resolved`, and nothing from the user for
  the tenant's days — counted from the later of the last message and the
  resolve — is closed with `closedAutomatically: true` and a `support.status`
  event. A thread waiting on an agent never closes by itself. The sweep is
  worker-service's `support_auto_close` (every 15 min) on `POST
  /api/internal/support/close-idle` (`SERVICE_AUTH_TOKEN`; 404 otherwise) →
  `{scanned, closed}`, at most 500 a run, across every tenant on the
  cross-tenant pool (its only reader).
- **Rating.** `POST /api/support/conversations/:id/rating` `{score 1–5,
  comment? ≤1000}` → `{score, comment, ratedAt}` — once, on the caller's own
  `resolved` or `closed` thread; 409 `not_finished`, 409 `already_rated`, 404.
  A summary carries `rating` (`null` until given); a reopen keeps it.
- **Reopen.** `POST …/conversations/:id/reopen` → `{id, status}` on the
  caller's own `closed` thread within `reopenWithinDays` of `closedAt`: back
  to `open` if no agent ever answered, else `pending_agent`; its SLA clock
  runs again. 409 `not_closed`, 409 `reopen_expired` (then a new thread), 409
  `too_many_unfinished`. A `resolved` one needs none — a message reopens it.

## Canned replies (F-033-j, catalog §11.3)

A short `key` and a text per language, owned like a category: `tenantId` NULL
is the platform's defaults (`greeting`, `more_info`, `reconnect`,
`resolved_check`), and a tenant's own reply with the same key hides that
default — retiring its own copy drops it (user, 2026-10-03). Inserting one
stores nothing: the agent edits the text and sends an ordinary reply.

| Route | Who | Input | Output | Errors |
|---|---|---|---|---|
| `GET …/agent/canned-replies` | `support.agent` | `Accept-Language` | `[{id, key, body, source: tenant\|platform}]`, active only, by `sortOrder` then key — the picker | — |
| `GET …/agent/conversations/:id/canned-replies/:replyId` | `support.agent` | — | `{body, lang}`: the text in the **conversation user's** `languagePreference` (else `fa`, else any), variables filled | 404 `not_found`, 404 `canned_unknown` |
| `GET /api/support/settings/canned-replies` | `support.manage` | — | the tenant's own, retired included: `[{id, key, sortOrder, isActive, texts: [{lang, body}]}]` | — |
| `POST` same | `support.manage` | `{key /^[a-z0-9_]{1,40}$/, texts: [{lang, body ≤4000}], sortOrder?, isActive?}` | the reply, 201 | 409 `canned_key_taken`, 400 `canned_invalid` |
| `PATCH …/canned-replies/:id` · `DELETE` | `support.manage` | any of the four (`texts` replaces every language) · — | the reply · 204 | 404 `canned_unknown`, 409, 400 |

Variables: `{user.name}` (the user's `fullName`), `{agent.name}` (the caller's),
`{tenant.name}` (the brand name, else the slug), `{conversation.subject}` —
filled in one pass, so a value is never expanded again. `canned_invalid`: no
language, one twice, or any other `{word.word}` — a typo never reaches a user.

## Categories (F-033-e, ADR-0112 point 6)

`support.manage`, the tenant's own only (a default answers `category_unknown`).
`GET /api/support/settings/categories` → `{own: [{id, key, sortOrder, isActive,
texts: [{lang, name ≤80}], inUse}], platform: [{id, key, name}], usingPlatform}`;
`POST` `{key /^[a-z0-9_]{1,40}$/, texts, sortOrder?, isActive?}` (201);
`PATCH …/:id` any of the four (`texts` replaces all); `DELETE …/:id` (204) only
while no conversation names it, else 409 `category_in_use` — retire it. 409
`category_key_taken`, 400 `category_invalid` (no name, a language twice).
Any active own category hides the defaults from users; none brings them back.

## Notices (F-033-i)

A thread with something for a reader who is not looking puts one row in their
panel inbox, which reaches an open panel over the socket; the user's two also go to their chats
(channel `bot`, with `conversationId` for the Open button, F-309) — a chat that cannot be told is logged, the row stands:

| When | Who | Template (auth-api `POST /internal/notify/user`) |
|---|---|---|
| an agent's reply (not a note) | the conversation's user | `supportReplied` |
| an agent resolves it | the conversation's user | `supportResolved` |
| the user writes (text or files) | the assignee; no one while unassigned — the queue is how a free agent finds it | `supportUserWrote` |

**One per conversation until read** (invariant 13): the reader's cursor when
told is kept (`support:notified:…`, 30 days); the next notice goes out only
once they have read past it. The words are auth-service's, in the reader's
language, with the subject as `{{subject}}`. Sent after the commit, off the
request: a refused or unset seam (`AUTH_API_BASE_URL`, `SERVICE_AUTH_TOKEN`)
is logged and not remembered — the message never fails for it.

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
| auth-api | `POST /internal/notify/user`, channel `inbox` (F-033-i), `bot` for the user's (F-309) | no notice; the message is stored and published as ever |

## Guarantees

- A conversation's history never moves between tables when its mode changes.
- A user never sees an agent's internal note (invariant 5).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| ticket / chat tables | 2026-10-03 | removed (empty) | `conversation` (ADR-0112) |
