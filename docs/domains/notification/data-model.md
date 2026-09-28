---
id: notification
layer: domain
status: active
updated: 2026-09-28
---

# Data model — notification

Source of truth: `txnet-backend/prisma/domains/notification.prisma` (Postgres schema
`notification`). Served by `notification-service` (ADR-0052).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| notification | one user-facing inbox item; `readAt` nullable, set once (invariant 6) | via user — no `tenantId`, no RLS; the gate's `userId` is the guard (invariant 5) | rolling |
| notification_campaign | broadcast: `channel`, `filterCriteria` JSON (strict schema, invariant 8), `messageBody`, `subject`, `sourceLang` (F-035-h), counts, send progress (`sendStartedAt`, `fanOutCursor`, `fannedOutAt`) | `tenantId` nullable (null = platform-wide); RLS shape B | long |
| notification_campaign_recipient | per-user delivery record `queued`/`sent`/`failed`, unique `(campaignId, userId)`; `claimedUntil` is a delivery run's lease | via campaign — no RLS of its own | long |
| notification_campaign_text | the campaign in one `Language` other than its source: `subject?`, `body`, `state` `draft`/`published`; unique `(campaignId, lang)`, cascades with the campaign (F-035-h, ADR-0055) | via campaign — no RLS of its own; reached only through `CampaignAdminService.managed` | as the campaign |
| retention_notice | the retention ledger: one row per `(grantId, notice, period)`, `eventId` = the event holding it (F-601-a, invariant 14); `botTenantId`, `botAt`, `botTemplate`, `botParams` hold a bot message kept for quiet hours, cleared once told (F-601-m) | via user — no `tenantId`, no RLS (`botTenantId` only names whose bot tells a held message); written only by the internal seam | kept |
| notification_preference | a user's notice settings, PK `userId`: `mutedKinds` (shared-core `RETENTION_MUTABLE_KINDS`), `quietStart`/`quietEnd` (minutes after local midnight, both or neither), `timezone` (IANA, default `Asia/Tehran`) (F-601-m, invariant 15) | via user — no `tenantId`, no RLS; the gate's `userId` is the guard | as the user |
| notification_grant_preference | a user's notice level for one Grant, PK `(userId, grantId)`: `level` (`GRANT_NOTICE_LEVELS`, only `essential` stored — `all` is no row) (F-601-o, invariant 15) | via user — no `tenantId`, no RLS; the gate's `userId` is the guard, and the claim reads it under the event's `userId` | as the user |

Enums: `NotificationType`, `NotificationChannel` (`push`, `sms`, `telegram_bot`,
`bale_bot`, `email`), `CampaignStatus` (`draft`, `sending`, `completed`),
`DeliveryStatus`, `CampaignTextState`. `sourceLang` and `lang` use
`identity`'s `Language` enum, the same type as `user.languagePreference`.

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| notification.userId, notification_campaign_recipient.userId | -> | identity.user.id | notifications target users (no FK across schemas) |
| notification_campaign.tenantId | -> | tenant.tenant.id | campaign scoped to a reseller's users |
| notification_campaign.sourceLang, notification_campaign_text.lang | -> | identity `Language` enum | delivery matches `user.languagePreference` |
| retention_notice.userId, retention_notice.grantId | -> | identity.user.id, entitlement.grant.id | whose notice, which Grant — named by the producer (no FK across schemas) |

## Access rules

No unit outside `notification` writes these tables — a reseller's suspension
stops its campaigns through the owner's `tenants/:tenantId/stop` (F-018-x), not a write. Other units create an inbox
item through `POST internal/notifications`. Campaign rows: a tenant admin on the
app pool (RLS behind the filter), the platform owner and the worker-driven
fan-out and delivery on the cross-tenant pool (ADR-0053). Texts and recipient
rows follow their campaign's access; delivery reads only `published` texts
(invariant 11).

## Migration notes

Committed under `txnet-backend/prisma/domains/migrations/`: RLS for
`notification_campaign` in `20260909001500_row_level_security_all_tables`;
`20260917000100_campaign_manage_permission`, `20260917000300_campaign_fan_out`,
`20260917000400_drop_campaign_executed_by_worker`,
`20260917000500_campaign_delivery_claim`,
`20260917000700_campaign_email_texts` (the `email` channel, `subject`,
`sourceLang`, `notification_campaign_text`), `20260917001800_campaign_stop`
(`CampaignStatus.stopped`, `stoppedAt`, F-018-q), `20260917001900_campaign_stop_by_hand`
(`AdminAction.campaign_stop`, F-018-x), `20260927001000_retention_notice_ledger`
(`retention_notice`, F-601-a), `20260927001900_retention_notice_preferences`
(`notification_preference`, the held bot message columns, F-601-m),
`20260928002000_a_service_told_essentials_only` (`notification_grant_preference`, F-601-o). Enum values added with
`ADD VALUE` cannot be rolled back.
