---
id: notification
layer: domain
status: active
version: 2
updated: 2026-09-17
---

# Contract — notification

Runs in `notification-service` (ADR-0052). **Live:** a user's in-app inbox
(F-035-a/b), campaign drafts (F-035-c) and sending them: one recipient row per
user, written on the worker (F-035-d), and delivered to Telegram and Bale
(F-035-e), and by SMS on the platform's line (F-035-f). Email is not built
(F-035-g/h); a reseller's own SMS line waits for F-035-i.

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
| draft a campaign | `POST notifications/campaigns` (gated, `campaign.manage`) | `{ channel, messageBody ≤4000, audience, tenantId?: uuid\|null }` | the campaign, 201 | 400; 403 no permission or `not_platform_owner`; 404 `tenant_not_found`; 409 `sms_not_available` |
| list campaigns | `GET notifications/campaigns` | `page`, `pageSize` ≤100, `status?`, `tenantId?: uuid\|platform` (owner only) | `{ items[], page, pageSize, total }`, newest first | 400, 403 |
| read one | `GET notifications/campaigns/:id` | — | the campaign | 403; 404 `campaign_not_found` |
| edit a draft | `PATCH notifications/campaigns/:id` | any of `channel`, `messageBody`, `audience` (≥1) | the campaign | 400, 403, 404; 409 `campaign_not_draft`, `sms_not_available` |
| start a send | `POST notifications/campaigns/:id/send` | — | the campaign, `status: sending`, 200 | 403, 404; 409 `campaign_not_draft` |
| fan out | `POST internal/notifications/campaigns/fan-out` (`SERVICE_AUTH_TOKEN`) | — | `{ campaigns, recipients, finished, unreadable }` | 404 on a wrong token |
| deliver | `POST internal/notifications/campaigns/deliver` (token) | — | `{ claimed, sent, failed, deferred, stalled }` | 404 on a wrong token |
| record an outcome | `POST internal/notifications/campaigns/recipients/:id/outcome` (token) | `{ outcome: sent\|failed }` | `{ changed }` | 400; 404 `recipient_not_found` |

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
- **The pool follows the caller (ADR-0053).** A tenant admin runs on the app
  pool, bound by `withTenant` (`notificationCampaign` is tenant-scoped), so RLS
  stands behind the filter. Only the platform owner runs on the cross-tenant
  pool (`DATABASE_CROSS_TENANT_URL`), since shape-B RLS refuses platform-wide
  and other tenants' writes to every tenant's connection. No audit row yet —
  a draft reaches nobody; starting a send (F-035-d) is the audited act.

### Sending (F-035-d)

- **Start.** `send` flips `draft -> sending` and sets `sendStartedAt` in the
  write's own `where`, with an `admin_audit_log` row (`campaign_send`) in the
  same transaction. The pool follows the caller, as for drafts.
- **Fan-out.** `worker-service`'s `notification_campaign_fan_out` job calls the
  internal route each tick (`automation/contract.worker.md`). It runs on the
  cross-tenant pool — no tenant binding reads a platform-wide audience — so the
  user query's `tenantId` is invariant 1's whole guard. The audience is the
  stored filter parsed again, plus `deletedAt` null and `createdAt ≤
  sendStartedAt`; a filter that no longer parses sends to nobody and counts as
  `unreadable`.
- **Resumable.** Keyset batches over `user.id` (500), at most 5000 rows a call.
  A batch's rows and `fanOutCursor` commit together; the unique
  `(campaignId, userId)` index and `skipDuplicates` make a replay write nothing.
  The last batch sets `fannedOutAt`.
- **Outcome.** `queued -> sent|failed` only (`where deliveryStatus = queued`),
  and the matching counter moves in that transaction; an already-moved row is
  `changed: false` and counts nothing. `sending -> completed` once `fannedOutAt`
  is set and no row is `queued` — at once for an empty audience.
- The seed schedules the job `always_on` (user, 2026-09-17); an install that
  skips the seed fans out nothing until an operator sets its `bot_schedule`.

### Delivering to Telegram and Bale (F-035-e, ADR-0054)

- **Who drives.** `worker-service`'s `notification_campaign_delivery` job
  (seeded `always_on`, as the fan-out) calls `deliver` each tick. One call
  claims at most 100 `queued` rows of `sending` campaigns whose channel is
  `telegram_bot`/`bale_bot`, sends one at a time, stops sending after 40s.
- **The claim** (invariant 4). `FOR UPDATE SKIP LOCKED` plus a 300s
  `claimedUntil` lease: an overlapping run takes other rows, and a run that
  died frees its rows when the lease ends — a row it had sent but not recorded
  may then go twice (ADR-0027's at-least-once).
- **Whose bot, which chat** (invariant 9). The recipient's own tenant's primary
  bot on the campaign's platform, to the chat that user linked in that tenant
  with `contactVerifiedAt` set. The bot and its token come from `messenger`'s
  registry, answered by `auth-service` over `internal/bot-integrations`
  (`primary`, then `token` — audited as `notification-service:notification:CampaignDelivery`).
  `messageBody` goes as plain text, no `parse_mode`.
- **Outcomes.** `failed` — the final ones: no verified chat on that platform,
  no primary bot or a `disabled` one, a 400/403 from the platform (chat gone,
  bot blocked). `sent` on success. Both through `recordOutcome` (invariant 2).
  **Left `queued`**, released for a later run: a 429 (every row of that bot
  waits until `retry_after`; `deferred`), a 5xx or network error or the time
  limit (`deferred`), and an `auth-service` that did not answer or a token that
  could not be read (`stalled` — the job counts these as errors). A campaign
  stays `sending` while any row is queued.
- Needs `AUTH_API_BASE_URL` on `notification-service`; unset, every row stalls.

### Delivering by SMS (F-035-f, D-38)

- **One line, unmetered.** The platform's gateway (`SMS_API_URL`/`SMS_API_KEY`/
  `SMS_SENDER`, the OTP one; the driver is `shared-core`'s `SmsProviderService`).
  Nothing bills it yet, so it carries only **the platform owner's own campaign
  to the platform owner's own users** (invariant 10): a reseller's would cost
  the platform, a platform-wide one would show a reseller's customer the
  platform's number. `sms-line.ts` `SmsLineResolver.lineFor` is the one place
  that decides; F-035-i (a reseller's line, metering on `sms_sent`) changes it.
- **Refused at the draft.** `channel: sms` on create, or a patch to it, is 409
  `sms_not_available` unless the caller is the platform owner and the campaign
  is their own tenant's. Delivery checks the same rule again (cross-tenant pool).
- **Who receives.** `user.phoneNumber` with `phoneVerifiedAt` set; otherwise `failed`.
  The text goes as stored, no placeholder substitution.
- **Outcomes**, claimed and leased with the bot rows (same job, same budget):
  `sent`; `failed` for an ineligible row or `InvalidReceiverNumber`. **Left
  `queued`:** a transport failure or the time limit (`deferred`); an unset line,
  or any other gateway refusal — credentials, credit — (`stalled`), and after
  such a refusal no further SMS is tried that run.

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
| automation | `worker-service` ticks the fan-out (F-035-d) and delivery (F-035-e) | a started campaign stays `sending`, its rows unwritten or `queued`, until the next run |
| messenger | `BotClientRegistry`, `TelegramLikeBotClient.sendText` (F-035-e) | — (a library) |
| auth-api | `internal/bot-integrations/primary` and `/token` (ADR-0054) | rows stay `queued`, counted `stalled` |
| SMS gateway (external) | `SendSms`, through `shared-core` `SmsProviderService` (F-035-f) | SMS rows stay `queued`, `deferred` or `stalled` |
| tenant | the caller's `tenantType` (platform owner or not); a named tenant exists | 404 `tenant_not_found` |
| identity | `campaign.manage` in the gate's permissions (migration `20260917000100`) | 403 |

## Guarantees

- `readAt` is written once, by the first mark-read (invariant 5).
- Campaign execution is idempotent per `(campaignId, userId)`: one row, one counted outcome (F-035-d); one run holds a row while it sends (F-035-e).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
