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
| 5 | No user-facing read returns an `internal` message | service | an agent's note reaches the user |
| 6 | A user reads and writes only conversations whose `userId` is theirs | service | one user reads another's thread inside a tenant |
| 7 | A `closed` conversation takes no message; a `resolved` one is reopened by the user's message | service | a dead thread silently grows |
| 8 | No URL is stored for an attachment — only the storage key | schema (`objectKey`) | public, guessable file addresses (§11.4) |

## How to test

`support-service/src/app/conversations/support-schema.int.spec.ts` (`npm run
test:int`) holds 4 and the storage half of 8 against the migration history.
The service rules (3, 5, 6, 7) are covered by the unit spec of the service.
