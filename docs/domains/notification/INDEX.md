---
id: notification
layer: domain
status: active
version: 11
keywords: [notification, notice settings, quiet hours, mute notices, essential notices only, notices per service, campaign, delivery, push, sms, email, bulk send, reseller campaign, ارسال انبوه, stop a reseller's campaigns, stop sending campaigns, توقف ارسال کمپین‌های نماینده]
source:
  - txnet-backend/notification-service/**
  - txnet-backend/prisma/domains/notification.prisma
owns_tables: [notification, notification_campaign, notification_campaign_recipient, notification_campaign_text, retention_notice, notification_preference, notification_grant_preference]
depends_on: [identity, tenant, automation]
updated: 2026-09-28
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
| 2026-09-27 | v6 -> **v7** (additive, F-601-a): the retention ledger — `internal/notifications/retention/claim`, each retention notice told once per Grant period through ADR-0084's path ([contract.retention.md](contract.retention.md)) |
| 2026-09-27 | v7 -> **v8** (additive, F-601-m): a user's notice settings — `GET`/`PUT notifications/preferences` (muted kinds, quiet hours); the claim answers how a notice is told, and `retention/hold`, `held/take`, `held/told` release a bot message after quiet hours ([contract.retention.md](contract.retention.md)) |
| 2026-09-28 | v8 -> **v9** (additive, F-601-o): a notice level per service — `GET notifications/preferences/grants`, `PUT …/grants/:grantId`; the claim answers `muted` for any kind but `cutoff` on a Grant set to `essential` ([contract.retention.md](contract.retention.md) "One service, essentials only") |
| 2026-09-28 | v9 -> **v10** (additive, F-601-p): the claim takes `waitSec` (a patient notice's wait; quiet hours starting inside it hold the bot), and `held/take` answers each row's `grantId`, so several services' notices are told as one message naming them ([contract.retention.md](contract.retention.md) "Several services, one message") |
| 2026-10-01 | v10 -> **v11** (F-019-v4, ADR-0107): a reseller's campaign `send` consumes one `campaign_sends_daily_max` unit from the quota engine — a fixed day instead of 24 rolling hours, overage sold from the billing wallet, a new refusal `reseller_quota_exhausted` beside `reseller_limit_reached` ([contract.reseller.md](contract.reseller.md)) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
