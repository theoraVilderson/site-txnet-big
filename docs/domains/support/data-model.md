---
id: support
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — support

Source of truth: `txnet-backend/prisma/domains/support.prisma` (Postgres schema
`support`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| ticket | subject, status, priority, assigned admin | via user | long |
| ticket_message | threaded body, `senderType` user/admin | via ticket | long |
| ticket_attachment | file URL (object storage) + mime | via message | object-storage lifecycle |
| chat_session | live chat, `active` / `closed`, assigned admin | via user | long |
| chat_message | **monthly partitioned** (`sentAt`); archived to object storage before DROP | via session | archive then drop partition |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| ticket.userId, chat_session.userId | -> | identity.user.id | support is per user |
| ticket (referenced) | -> | audit.impersonation_session.linkedTicketId | an impersonation may cite the ticket that justified it |

## Access rules

Draft. No service yet; when built, no unit outside `support` writes these
tables and reads go through a `support` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
