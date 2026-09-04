---
id: support
layer: domain
status: draft
version: 1
keywords: [ticket, support, chat, attachment]
source: []
owns_tables: [ticket, ticket_message, ticket_attachment, chat_session, chat_message]
depends_on: [identity, audit]
updated: 2026-09-04
---

# Support

**Responsibility (one sentence):** support tickets with threaded messages + attachments, and live chat sessions/messages between users and admins.
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

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
