---
id: support
layer: domain
status: active
updated: 2026-10-03
---

# Invariants — support

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `message` is append-only: a row is never updated or deleted row-wise; retention is a dropped partition | service (no update path) | history rewritten under a user |
| 2 | `senderKind` is set on every message and never changes | service | a user's words shown as an agent's |
| 3 | `seq` is gap-free and unique per conversation: issued by incrementing `conversation.lastSeq` in the insert's transaction | service + row lock | read cursors skip or repeat messages |
| 4 | Every support table and every message partition is tenant-isolated by RLS; categories are shared-read (NULL = platform default), never writable as NULL by a tenant | migration `20261003001100`, `ensure_message_partition` | one tenant reads another's support |
| 5 | No user-facing read returns an `internal` message, and none is published on `support:<conversationId>`; a note moves no status and no `lastMessageAt`. What is published names no agent account | service, `SupportAgentService.reply`, `SupportRealtime` | an agent's note reaches the user |
| 6 | A user reads and writes only conversations whose `userId` is theirs | service | one user reads another's thread inside a tenant |
| 7 | A `closed` conversation takes no message; a `resolved` one is reopened by the user's message | service | a dead thread silently grows |
| 8 | No URL is stored for an attachment — only the storage key; the file is `private` on the port | schema (`objectKey`), the upload policy | public, guessable file addresses (§11.4) |
| 9 | An attachment's URL is minted only on the owning user's read (or a `support.agent` of its tenant's), only for a `clean` file, and lives five minutes | service (`attachmentView`), `private-files` verifying the signature | an unscanned or another user's file is fetched |
| 10 | A user's attachments, across all their conversations, never exceed `SUPPORT_STORAGE_QUOTA_BYTES`; no file is stored before the scanner passed it, and a refused upload leaves no bytes | `SupportAttachmentService` (per-user advisory lock in the insert's transaction) | one user fills the volume; an infected file sits on disk |
| 11 | `mode` is `live` only when, at the moment of the write, an agent's heartbeat is current **and** the tenant's wall clock is inside its hours (none = always); an unreadable presence is `async` | `SupportAvailability.mode`, called on open, send, attach, reply | a user waits on a live chat no one is in |

## How to test

`support-service/src/app/conversations/support-schema.int.spec.ts` (`npm run
test:int`) holds 4 and the storage half of 8 against the migration history.
The service rules (3, 5, 6, 7) are covered by the unit spec of the service.
The signature, expiry, PDF sniffing and the scanner verdicts behind 9 are
`shared-core/src/lib/object-storage/private-file.spec.ts`; 6 and 10 for uploads
are `attachments.service.int.spec.ts`. The agent side (3, 5, 7, the tenant
boundary, who may be assigned) is `agent/agent.service.int.spec.ts`; 11 is
`availability/availability.spec.ts` and, on the stored thread, the agent int spec.
