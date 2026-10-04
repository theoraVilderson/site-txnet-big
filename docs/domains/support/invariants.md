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
| 4 | Every support table and every message partition is tenant-isolated by RLS; categories and canned replies are shared-read (NULL = platform default), never writable as NULL by a tenant | migrations `20261003001100`, `20261003001600`, `ensure_message_partition` | one tenant reads another's support |
| 5 | No user-facing read returns an `internal` message, and none is published on `support:<conversationId>`; a note moves no status and no `lastMessageAt`. What is published names no agent account | service, `SupportAgentService.reply`, `SupportRealtime` | an agent's note reaches the user |
| 6 | A user reads and writes only conversations whose `userId` is theirs | service | one user reads another's thread inside a tenant |
| 7 | A `closed` conversation takes no message; a `resolved` one is reopened by the user's message | service | a dead thread silently grows |
| 8 | No URL is stored for an attachment — only the storage key; the file is `private` on the port | schema (`objectKey`), the upload policy | public, guessable file addresses (§11.4) |
| 9 | An attachment's URL is minted only on the owning user's read (or a `support.agent` of its tenant's), only for a `clean` file, and lives five minutes | service (`attachmentView`), `private-files` verifying the signature | an unscanned or another user's file is fetched |
| 10 | A user's attachments, across all their conversations, never exceed `SUPPORT_STORAGE_QUOTA_BYTES`; no file is stored before the scanner passed it, and a refused upload leaves no bytes | `SupportAttachmentService` (per-user advisory lock in the insert's transaction) | one user fills the volume; an infected file sits on disk |
| 11 | `mode` is `live` only when, at the moment of the write, an agent's heartbeat is current **and** the tenant's wall clock is inside its hours (none = always); an unreadable presence is `async` | `SupportAvailability.mode`, called on open, send, attach, reply | a user waits on a live chat no one is in |
| 12 | A conversation's SLA due times are `createdAt` + its priority's target in the tenant's working minutes (resolution + the working time stopped), recomputed in the transaction of every write that can move them; `slaDueAt` is null exactly while the clock is stopped or the thread finished | `applySla` (open, user message, agent reply, settle, priority) | the queue orders by a stale clock; a breach is reported that was not one |
| 13 | A reader gets at most one new-message notice per conversation until their cursor passes where it stood when told; a note tells no one, an unassigned thread tells no agent; a notice is sent after the commit and never fails or rolls back the message | `SupportNotifier`, called from `send`, `attach`, `reply`, `resolve` | a busy thread floods the inbox, or a refused seam loses a user's message |
| 14 | Only a thread waiting on its user (`pending_user`/`resolved`) closes by itself, and only past its tenant's days of silence from the user, re-checked under the row lock; a rating is written once (1–5) on a resolved or closed thread; a closed thread reopens only inside its tenant's window | `SupportLifecycle` (`closeIdle`, `rate`, `reopen`), CHECKs in `20261003001700` | a queue that empties itself, a rating rewritten, a final thread reopened |
| 15 | Platform staff reach a reseller's conversations only under that reseller's live consent, read on every request; `read` never writes; the work runs in the reseller's tenant scope (F-033-l, ADR-0104 (4)) | `PlatformSupportDoor` | the platform reads every reseller's customers' support at will |

## How to test

`support-service/src/app/conversations/support-schema.int.spec.ts` (`npm run
test:int`) holds 4 and the storage half of 8 against the migration history.
The service rules (3, 5, 6, 7) are covered by the unit spec of the service.
The signature, expiry, PDF sniffing and the scanner verdicts behind 9 are
`shared-core/src/lib/object-storage/private-file.spec.ts`; 6 and 10 for uploads
are `attachments.service.int.spec.ts`. The agent side (3, 5, 7, the tenant
boundary, who may be assigned) is `agent/agent.service.int.spec.ts`; 11 is
`availability/availability.spec.ts` and, on the stored thread, the agent int spec;
12 is `sla/sla.int.spec.ts`; 13 is `notify/support-notifier.spec.ts` (the dedupe) and the agent int spec (who is told). Canned replies: `canned/canned.spec.ts` (variables, language), the agent int spec (visibility, 4). 15 is `agent/platform-door.spec.ts`. 14 is `lifecycle/lifecycle.int.spec.ts`.
