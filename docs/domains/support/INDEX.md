---
id: support
layer: domain
status: active
version: 2
keywords: [ticket, support, chat, attachment, conversation, support category, پشتیبانی, تیکت, گفتگو]
source:
  - txnet-backend/prisma/domains/support.prisma
  - txnet-backend/support-service/**
owns_tables: [conversation, message, conversation_read, message_attachment, support_category, support_category_text, working_hours, sla_policy]
depends_on: [identity, audit]
updated: 2026-10-03
---

# Support

**Responsibility (one sentence):** one support conversation per thread — ticket and live chat are its modes (ADR-0112) — with its messages, read cursors, attachments and per-tenant categories.
**Explicitly NOT responsible for:** impersonation (`audit`/`identity`), notifications about tickets (`notification`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing support from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |
| 2026-10-03 | v2: ticket/chat tables replaced by one conversation (ADR-0112, F-033-a) — contract break |
| 2026-10-03 | draft -> active: `support-service` serves the user's routes (F-033-b) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
