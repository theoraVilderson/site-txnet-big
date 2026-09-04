---
id: notification
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — notification

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/notification.prisma`.

## TL;DR

Per-user in-app `notification` rows (type, title, body, `readAt`). Admin `notification_campaign` with a JSON audience filter, executed by an `automation` worker, fanning out to `notification_campaign_recipient` rows with a per-recipient `deliveryStatus`. `tenantId = null` = platform-wide campaign.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| create notification | userId, type, title, body | `notification` | sync | — |
| mark read | userId, notificationId(s) | updated `readAt` | sync | — |
| create campaign | adminId, channel, filter, body | `notification_campaign` (`draft`) | sync | — |
| execute campaign | campaignId | recipients + `sending` -> `completed` | async (worker) | filter invalid |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`, audience resolution | fan-out blocked |
| tenant | scope a campaign to one tenant's users | platform-wide only |
| automation | the worker that executes the campaign | campaign stuck in `draft`/`sending` |

## Guarantees (intended)

- Campaign execution is idempotent per recipient (one row per `(campaignId, userId)`).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
