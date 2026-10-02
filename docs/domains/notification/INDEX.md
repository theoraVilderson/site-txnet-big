---
id: notification
layer: domain
status: active
version: 13
keywords: [notification, notice settings, quiet hours, mute notices, essential notices only, notices per service, campaign, delivery, push, sms, email, bulk send, reseller campaign, ارسال انبوه, stop a reseller's campaigns, stop sending campaigns, توقف ارسال کمپین‌های نماینده]
source:
  - txnet-backend/notification-service/**
  - txnet-backend/prisma/domains/notification.prisma
owns_tables: [notification, notification_campaign, notification_campaign_recipient, notification_campaign_text, retention_notice, notification_preference, notification_grant_preference]
depends_on: [identity, tenant, automation]
updated: 2026-10-02
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
| [contract.reseller-quota.md](contract.reseller-quota.md) | a reseller is told about its quotas — 80%, 100%, stopped, the daily digest (F-019-v8) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-28 | v8 -> **v9** (additive, F-601-o): a notice level per service — `GET notifications/preferences/grants`, `PUT …/grants/:grantId`; the claim answers `muted` for any kind but `cutoff` on a Grant set to `essential` ([contract.retention.md](contract.retention.md) "One service, essentials only") |
| 2026-09-28 | v9 -> **v10** (additive, F-601-p): the claim takes `waitSec` (a patient notice's wait; quiet hours starting inside it hold the bot), and `held/take` answers each row's `grantId`, so several services' notices are told as one message naming them ([contract.retention.md](contract.retention.md) "Several services, one message") |
| 2026-10-01 | v10 -> **v11** (F-019-v4, ADR-0107): a reseller's campaign `send` consumes one `campaign_sends_daily_max` unit from the quota engine — a fixed day instead of 24 rolling hours, overage sold from the billing wallet, a new refusal `reseller_quota_exhausted` beside `reseller_limit_reached` ([contract.reseller.md](contract.reseller.md)) |
| 2026-10-01 | v11 -> **v12** (additive, F-019-v8, ADR-0107 point 11): a reseller's owner told at 80%, 100% (overage started or stopped), stopped for want of money, and by a daily digest from 09:00 — `internal/notifications/reseller-quota/digest`, outbox `tenant.quota.alert` / `.digest` ([contract.reseller-quota.md](contract.reseller-quota.md)) |
| 2026-10-02 | v12 -> **v13** (behaviour change, TZ-1-f, ADR-0108 point 6): `notification_preference.timezone` nullable — null = the user's resolved zone; `GET notifications/preferences` with no row answers `timezone: null`, `PUT` takes null. Existing rows keep their zone. Consumer: panel-web (TZ-1-e) ([contract.retention.md](contract.retention.md)) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
