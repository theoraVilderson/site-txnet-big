---
id: notification
layer: domain
status: draft
version: 1
keywords: [notification, campaign, delivery, push, sms, email]
source: []
owns_tables: [notification, notification_campaign, notification_campaign_recipient]
depends_on: [identity, tenant, automation]
updated: 2026-09-04
---

# Notification

**Responsibility (one sentence):** the notification hub: per-user in-app notifications, admin broadcast campaigns with audience filters, and per-recipient delivery state across push/SMS/bot channels.
**Explicitly NOT responsible for:** actually sending SMS/bot messages (delivery adapters), authoring the events that trigger notifications.

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

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
