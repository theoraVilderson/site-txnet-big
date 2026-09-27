---
id: notification
layer: domain
status: active
version: 8
keywords: [notification, notice settings, quiet hours, mute notices, campaign, delivery, push, sms, email, bulk send, reseller campaign, ارسال انبوه, stop a reseller's campaigns, stop sending campaigns, توقف ارسال کمپین‌های نماینده]
source:
  - txnet-backend/notification-service/**
  - txnet-backend/prisma/domains/notification.prisma
owns_tables: [notification, notification_campaign, notification_campaign_recipient, notification_campaign_text, retention_notice, notification_preference]
depends_on: [identity, tenant, automation]
updated: 2026-09-27
---

# Notification

**Responsibility (one sentence):** the notification hub: per-user in-app notifications, admin broadcast campaigns with audience filters, and per-recipient delivery state across push/SMS/bot channels.
**Explicitly NOT responsible for:** Telegram/Bale drivers (`messenger`, D-10), authoring the events that trigger notifications. Runs in `notification-service` (ADR-0052).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing notification from outside |
| [contract.reseller.md](contract.reseller.md) | a reseller drafts, sizes or starts a campaign of its own (F-313-d) |
| [contract.retention.md](contract.retention.md) | a domain emits a retention notice, or a row adds one (F-601) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-17 | v3 -> **v4**: `CampaignStatus.stopped` — a reseller's sends stop with its suspension; `resume`, `sending-summary`, internal `stop` (F-018-q) |
| 2026-09-17 | v4 -> **v5** (**break**): the internal `tenants/:tenantId/stop` route is gone — the platform owner's own `campaigns/tenants/:tenantId/stop` is the only way in (F-018-w, ADR-0058 (5)) |
| 2026-09-20 | v5 -> **v6** (additive, F-313-d): a reseller-named campaign surface — `tenants/:tenantId/campaigns…`, admitted by `ResellerAccess`, with an audience count so a segment is sized before it is sent ([contract.reseller.md](contract.reseller.md)) |
| 2026-09-27 | v6 -> **v7** (additive, F-601-a): the retention ledger — `internal/notifications/retention/claim`, each retention notice told once per Grant period through ADR-0084's path ([contract.retention.md](contract.retention.md)) |
| 2026-09-27 | v7 -> **v8** (additive, F-601-m): a user's notice settings — `GET`/`PUT notifications/preferences` (muted kinds, quiet hours); the claim answers how a notice is told, and `retention/hold`, `held/take`, `held/told` release a bot message after quiet hours ([contract.retention.md](contract.retention.md)) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
