---
id: notification
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — notification

Source of truth: `txnet-backend/prisma/domains/notification.prisma` (Postgres schema
`notification`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| notification | one user-facing notification; `readAt` nullable | via user | rolling |
| notification_campaign | broadcast: channel, `filterCriteria` JSON, body, counts, executing worker | `tenantId` nullable | long |
| notification_campaign_recipient | per-user delivery record (`queued`/`sent`/`failed`) | via campaign | long |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| notification.userId, notification_campaign_recipient.userId | -> | identity.user.id | notifications target users |
| notification_campaign.tenantId | -> | tenant.tenant.id | campaign scoped to a reseller's users |
| notification_campaign.executedByBotWorkerId | -> | automation.bot_worker.id | the worker that ran the fan-out |

## Access rules

Draft. No service yet; when built, no unit outside `notification` writes these
tables and reads go through a `notification` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
