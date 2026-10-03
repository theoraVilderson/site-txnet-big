---
id: adr-0112
status: accepted
updated: 2026-10-03
---

# ADR 0112 — support is one Conversation, served by `support-service`

- **Status:** accepted (F-033-a storage, F-033-b the user's API; F-033-c…e follow)
- **Date:** 2026-10-03. Points 1, 2, 3 and 5 were chosen by the user in
  conversation, each the recommended option; the rest follow from them.
- **Affects units:** support, audit (the impersonation link), ai (the
  quiet-down reader), forward-auth (a new routed prefix)
- **Supersedes:** the ticket / chat split in `support.prisma` (20260908000000_init)

## Context

The schema carried two products: `ticket` + `ticket_message` +
`ticket_attachment`, and `chat_session` + `chat_message`. No service ever
wrote them (all five empty on 2026-10-03). Catalog §11.1 says the opposite:
one support entity, one door, and "live" or "async" is a moment-in-time
attribute of a thread, never a record type. §11.4 puts attachments behind
short-lived signed URLs, §11.6 makes support tenant- and reseller-scoped.

## Decision

1. **A new Nest app, `support-service`, serves every `/api/support/*` route**,
   built like `currency-service` (ADR-0100): behind Traefik and ForwardAuth,
   the RLS app pool, the shared guards (C-11), locale, Redis for the limiter.
   The inbox, SLA, attachments and the bot's support all land here, not in a
   service that owns something else.
2. **One `conversation` replaces the five tables**, which are dropped (empty;
   the migration asserts it). `audit.impersonation_session.linkedTicketId`
   becomes `linkedConversationId`; `ai.reader_open_ticket` keeps its name and
   columns and reads `conversation`, so F-1506's quiet-down is unchanged.
3. **`message` is monthly range-partitioned on `createdAt`, from day one**,
   with `(id, createdAt)` as the key (`traffic_raw_log`'s shape, F-027-e). No
   `DEFAULT` partition. `support.ensure_message_partition(month)` is
   `SECURITY DEFINER`, policies what it creates (F-027-ak), and is called by
   the service when an insert finds no partition — once a month, then never.
   Retention (archive, then `DROP PARTITION`) is a row of its own.
4. **Messages are append-only and ordered by a per-conversation `seq`**,
   issued by incrementing `conversation.lastSeq` in the insert's transaction —
   the row lock serialises two senders, so `seq` is gap-free and unique
   without a unique index a partitioned table could not hold. `senderKind` is
   `user | agent | system | bot | ai` (§11.1) and never changes. `internal` marks
   an agent's note (§11.3): **no user-facing read ever returns one**.
5. **Read state is a cursor, not a `readAt` per message**:
   `conversation_read(conversationId, userId, lastReadSeq)`. Marking read is
   one upsert whatever the backlog; many agents read one thread without
   writing its messages. A user's unread count is messages not their own, not
   internal, past their cursor.
6. **Categories are per tenant, named per language** (`support_category` +
   `support_category_text`, `Language`). Rows with `tenantId` NULL are the
   platform's default set, read by every tenant through RLS; **a tenant with
   any active category of its own sees only its own** — no seeding on tenant
   creation, and no copy to keep in step. A category in use is retired
   (`isActive`), never deleted.
7. **An attachment is a `message_attachment` row naming a
   `storage.stored_object` key** (D-8's port), with a `scanStatus`
   (`pending | clean | infected | failed`). No URL is ever stored; a 5-minute
   signed one is minted on read (F-033-c).
8. **Isolation:** every table carries `tenantId` under the standard
   `tenant_isolation` policy; a user's routes also filter by their `userId`.
   `resellerPath` is on `conversation` and stays NULL until reseller nodes
   exist (F-901, C-15), as on `grant`.
9. **Status**: `open` until the first agent reply, then `pending_user` /
   `pending_agent` by who wrote last; a user's message reopens a `resolved`
   conversation; `closed` takes no message — the user opens a new one. `mode`
   is `async` until agent presence exists (catalog §11.2, a later child).
   `priority` (`low | normal | high | urgent`) only orders the queue (§11.5).
10. **Abuse limits**: per-user rate limits on reading, opening and sending,
    and a cap on a user's unfinished conversations — env-tunable
    (`SUPPORT_*`); a message body is at most 4000 characters.

## Consequences

- One more process to build, run and watch.
- A conversation's history never moves between tables when a human comes
  online; the bot (F-309) and the panel write the same rows.
- A month with no partition is a retried insert, not a lost message; a
  forgotten retention job grows the table but loses nothing.

## Revisit trigger

Messages need a global uniqueness the partition key cannot carry, or a
reseller node (F-901) needs its own visibility rule beyond its tenant.
