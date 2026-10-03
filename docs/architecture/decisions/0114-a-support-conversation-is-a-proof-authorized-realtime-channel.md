---
id: adr-0114
status: accepted
updated: 2026-10-03
---

# ADR 0114 — a support conversation is a realtime channel authorized by a proof

- **Status:** accepted (F-034)
- **Date:** 2026-10-03. Chosen by the user in conversation, the recommended
  option over publishing on the owner's `user:` channel.
- **Affects units:** realtime (a fourth channel family), support

## Context

Live chat needs a thread's events — a new message, "seen", "typing" — to reach
everyone reading it: the user now, agents with F-033-d, the bot with F-309.
The gateway holds no database (realtime guarantee), so it cannot ask who owns
a conversation. Publishing on the owner's `user:` channel would work for the
user alone and leave agents needing a second channel, with every event sent
twice in two shapes.

## Decision

1. **`support:<conversationId>` is a channel family.** Its readers are
   whoever support-service hands a proof to.
2. **The proof is minted by support-service on a read of the thread** — only
   after its own ownership check — as 32 random bytes at
   `support:channel:<conversationId>:<userId>` (unscoped, TTL one hour,
   refreshed on each read, reused while it lives so tabs share it).
3. **The gateway needs an identity and the proof**: it reads the key for the
   connection's own `userId` and compares in constant time. A proof copied to
   another account names a key that does not exist; an anonymous socket has
   no id to look one up by. A resume cannot carry it, as for `otp:`.
4. **Events are `support.message`, `support.read`, `support.typing`**, the
   actor named by kind, never by account. **An internal note is never
   published on this channel** — the user is one of its readers.
5. **Typing travels over HTTP** (`POST …/:id/typing`), not as a client frame:
   the socket stays read-only for clients, and the rate limit and ownership
   check stay where every other support rule lives.

## Consequences

- F-033-d gives an agent a proof after its own permission check, and nothing
  in the gateway changes.
- A user removed from a thread keeps hearing it until their socket closes —
  conversations are never reassigned to another user, so this is accepted.

## Revisit trigger

A reader's access must end while their socket is open (an agent unassigned
from a sensitive thread).
