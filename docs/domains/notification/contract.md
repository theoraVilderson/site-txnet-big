---
id: notification
layer: domain
status: active
version: 2
updated: 2026-09-17
---

# Contract — notification

Runs in `notification-service` (ADR-0052). **Live:** a user's in-app inbox
(F-035-a/b) and campaign drafts (F-035-c). Sending a campaign (F-035-d) and
delivery (F-035-e/f) are not built — nothing moves a draft on or writes
`notification_campaign_recipient`.

## TL;DR

A user reads a page of their own `notification` rows with the unread count,
and marks some or all read. Another unit puts a row in a user's inbox through
the internal seam, and the row reaches the user's open panel over the socket. Whose inbox is always the gate's `X-User-Id`.
An admin holding `campaign.manage` drafts campaigns for their own tenant; the
platform owner also for the whole platform or any tenant.

## Provides

All routes under `/api`. Envelope, errors and 429 as every service (F-094).

| Operation | Route | Input | Output | Errors |
|---|---|---|---|---|
| read the inbox | `GET notifications` (gated) | `page`, `pageSize` (≤100, default 1/20), `unreadOnly=true\|false` | `{ items[], page, pageSize, total, unreadCount }`; item = `id, type, title, body, readAt, createdAt` (ISO), newest first | 400 `validation.failed`, 401 |
| mark read | `POST notifications/read` (gated) | `{ ids?: uuid[1..100] }` — absent = all | `{ marked, unreadCount }` | 400, 401 |
| create | `POST internal/notifications` (`SERVICE_AUTH_TOKEN`) | `{ userId, type, title ≤200, body ≤2000 }` | the item, 201 | 400; 404 on a missing or wrong token |
| draft a campaign | `POST notifications/campaigns` (gated, `campaign.manage`) | `{ channel, messageBody ≤4000, audience, tenantId?: uuid\|null }` | the campaign, 201 | 400; 403 no permission or `not_platform_owner`; 404 `tenant_not_found` |
| list campaigns | `GET notifications/campaigns` | `page`, `pageSize` ≤100, `status?`, `tenantId?: uuid\|platform` (owner only) | `{ items[], page, pageSize, total }`, newest first | 400, 403 |
| read one | `GET notifications/campaigns/:id` | — | the campaign | 403; 404 `campaign_not_found` |
| edit a draft | `PATCH notifications/campaigns/:id` | any of `channel`, `messageBody`, `audience` (≥1) | the campaign | 400, 403, 404; 409 `campaign_not_draft` |

- `unreadCount` is over the whole inbox, whatever the page or filter.
- `marked` counts rows that changed. An id that is read already, does not exist
  or is another user's all count 0 alike — no route reveals another inbox.
- `title`/`body` are stored text: the caller renders the user's language first.
- Rate limits, per user, 15 min: `NOTIFICATION_READ` (300), `NOTIFICATION_WRITE`
  (120). The internal seam is not limited.

### Campaigns (F-035-c)

- A campaign = `id, tenantId (null = platform-wide), createdByAdminId, channel,
  audience, messageBody, status, sentCount, failedCount, createdAt`.
  Refusals carry `{ reason }` for the panel to translate, as billing's coupons.
- **Scope.** `tenantId` absent = the caller's tenant. `null` or another tenant
  is the platform owner's alone, and fixed at creation. A tenant admin lists and
  reads only their own tenant's rows — not the platform's, although RLS would
  show them — and another tenant's id is 404, never 403 (invariant 7).
- **`audience` is a closed shape** (`campaign-admin.schema.ts`, closes the
  `filterCriteria` question). Strict: an unknown key is 400. Keys AND together,
  a list is any of its values, `{}` is everyone in scope:
  `statuses` (`UserStatus`, absent = `active` only), `languages` (`Language`),
  `registeredFrom`/`registeredTo` (ISO, `from` < `to`, on `user.createdAt`),
  `minBalance`/`maxBalance` (decimal text ≤2 places, C-02, inclusive, on
  `wallet.cachedBalance`; no wallet = 0). Lists are non-empty and distinct.
  The fan-out (F-035-d) translates exactly these keys; a new key lands in both
  in one change.
- **Only a draft is edited**, checked in the write's own `where` (invariant 8).
- Limits, per admin, 15 min: `NOTIFICATION_CAMPAIGN_READ` (300), `…_WRITE` (60).
- Rows are on the cross-tenant pool (`DATABASE_CROSS_TENANT_URL`): shape-B RLS
  refuses a platform-wide row to every tenant's connection. No audit row yet —
  a draft reaches nobody; starting a send (F-035-d) is the audited act.

## Emits (events)

| Event | When | Payload | Consumer |
|---|---|---|---|
| outbox `notification.created` | in the transaction of every `create` (ADR-0021) | `{ userId, notification: <the item> }` | `worker-service` republishes `{type:'notification.created', notification}` on `user:<userId>` (F-035-b, `automation/contract.outbox.md`) |

- The live push is at most once per event id and reaches only an open panel;
  the inbox route is the truth, so a panel reads the page on load and adds
  pushed items on top (F-093-h).
- Latency is the relay's tick — up to `AUTOMATION_TICK_INTERVAL_MS` (60s).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| forward-auth | identity headers on gated routes | 401 |
| identity | `userId` (no FK across schemas; a caller names a real user) | — |
| automation | the worker for campaign fan-out (F-035-d, not built) | — |
| tenant | the caller's `tenantType` (platform owner or not); a named tenant exists | 404 `tenant_not_found` |
| identity | `campaign.manage` in the gate's permissions (migration `20260917000100`) | 403 |

## Guarantees

- `readAt` is written once, by the first mark-read (invariant 5).
- Campaign execution will be idempotent per `(campaignId, userId)` (F-035-d).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
