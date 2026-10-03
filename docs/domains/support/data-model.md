---
id: support
layer: domain
status: active
updated: 2026-10-03
---

# Data model — support

Source of truth: `txnet-backend/prisma/domains/support.prisma` (Postgres schema
`support`). Shape decided in [ADR-0112](../../architecture/decisions/0112-support-is-one-conversation-served-by-support-service.md);
built by `20261003001100_support_is_one_conversation`, which dropped the
original ticket/chat tables empty.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| conversation | the one support thread: subject, category, `status`, `mode` (`live`/`async`), `priority`, assignee, `lastSeq`, first-response / last-message / resolved / closed times, SLA clocks (`firstResponseDueAt`, `resolutionDueAt`, `slaPausedAt`, `slaPausedSeconds`, `slaDueAt`, F-033-h), rating, AI triage label, `resellerPath` (NULL until F-901) | `tenantId`, RLS | long |
| message | append-only; `seq` per conversation, `senderKind` `user`/`agent`/`system`/`bot`/`ai`, `internal` (agent note). **Monthly range-partitioned on `createdAt`**, key `(id, createdAt)`, no `DEFAULT` partition | `tenantId`, RLS on parent and every partition | partition archived, then dropped (row of its own) |
| conversation_read | one reader's cursor: `lastReadSeq`, `readAt` | `tenantId`, RLS | with the conversation |
| message_attachment | a file on a message: `objectKey` (storage port), name, type, size, `scanStatus` | `tenantId`, RLS | with the message |
| working_hours | one open interval of the tenant's week (F-033-g): `weekday` 0–6, `startMinute`/`endMinute` on the tenant's wall clock (CHECKs). No row = always open | `tenantId`, RLS | replaced whole |
| sla_policy | targets per `priority` in working minutes (F-033-h). `tenantId` NULL = the platform's defaults (seeded by `20261003001500`); a tenant's row replaces one | shared-read RLS | replaced whole |
| support_category | `key`, order, `isActive`. `tenantId` NULL = platform default | shared-read RLS | long |
| support_category_text | a category's name per `Language` | shared-read RLS | with the category |

## Partitions

`support.ensure_message_partition(month)` — `SECURITY DEFINER`, granted to
`txnet_app`, idempotent, and policies the partition it makes or finds
(F-027-ak). The migration made 2026-10 … 2027-03; after that the service calls
it when an insert reports no partition for the row.

## Redis

| Key | Type | TTL | What |
|---|---|---|---|
| `support:channel:<conversationId>:<userId>` | string | 1h | a reader's realtime proof (F-034, ADR-0114) |
| `support:presence:<tenantId>` | sorted set: agent id → lapse instant (ms) | 90s, per beat | who is online (F-033-g); lapsed members dropped on read |
| `support:notified:<conversationId>:<userId>` | string: the reader's `lastReadSeq` when last told | 30d | one notice per thread until read (F-033-i) |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| conversation.userId, assignedToUserId | -> | identity.user.id (no FK) | support is per user |
| message_attachment.objectKey | -> | storage.stored_object.key (FK, restrict) | the bytes live behind the storage port (D-8) |
| conversation (referenced) | -> | audit.impersonation_session.linkedConversationId | an impersonation may cite the conversation that justified it |
| working_hours (zone) | -> | tenant.tenant.timezone (read, RLS) | the schedule is on the tenant's wall clock (ADR-0108) |
| conversation (read) | -> | ai.reader_open_ticket view | F-1506 quiet-down: user and since when, unfinished only |

## Access rules

Only `support-service` writes these tables, on the RLS app pool with the
caller's tenant bound. A user's routes additionally filter by their own
`userId`; no user-facing read returns an `internal` message.
