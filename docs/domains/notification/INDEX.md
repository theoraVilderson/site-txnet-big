---
id: notification
layer: domain
status: active
version: 3
keywords: [notification, campaign, delivery, push, sms, email]
source:
  - txnet-backend/notification-service/**
  - txnet-backend/prisma/domains/notification.prisma
owns_tables: [notification, notification_campaign, notification_campaign_recipient, notification_campaign_text]
depends_on: [identity, tenant, automation]
updated: 2026-09-17
---

# Notification

**Responsibility (one sentence):** the notification hub: per-user in-app notifications, admin broadcast campaigns with audience filters, and per-recipient delivery state across push/SMS/bot channels.
**Explicitly NOT responsible for:** Telegram/Bale drivers (`messenger`, D-10), authoring the events that trigger notifications. Runs in `notification-service` (ADR-0052).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing notification from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |
| 2026-09-17 | `draft` -> `active`, v2: `notification-service` and the inbox (F-035-a, ADR-0052) |
| 2026-09-17 | v2 -> **v3**: `TenantStatusGuard` judges every gated route — campaign writes `403 tenant.suspended`/`tenant.terminated` for a closed reseller (F-018-p) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
