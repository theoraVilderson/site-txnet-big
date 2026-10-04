---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-04
---

# Contract — panel-web: the user's support (F-033-o)

A topic file of [contract.md](contract.md) (§10). Two pages over
support-service's user routes and its `support:<id>` channel
([support contract](../../domains/support/contract.md), ADR-0112, ADR-0114).
The agent's side is F-033-p.

| Route | Component | What it does |
|---|---|---|
| `/support` | `support/_components/SupportView.tsx` | the caller's conversations (newest activity first, `nextBefore` pages), status, unread; the wait notice (`GET …/availability`); a new conversation — category (shown only when the tenant has any), optional subject (≤120), body (≤4000) |
| `/support/[id]` | `support/_components/SupportThreadView.tsx` | one thread: messages oldest first, "earlier" (`beforeSeq`), sender by kind, files, "seen" on the caller's last message, the agent typing; send, attach, rate, reopen |

Menu: the existing `support` entry (`_lib/panel-menu.ts`) now links
`PANEL_SUPPORT`, for every signed-in user — support answers each with their
own threads only. Client: `lib/support-api.ts`. Rules: `support/_lib/support.ts`,
pinned by `support/support.test.ts`.

## Rules

1. **The stored thread is the record; the channel only hurries it.** Messages
   are one list keyed by `seq` (`mergeMessages`): the sender's own answer,
   the channel's event and any re-read overlap, and the later copy wins (its
   file URLs are newer). A page whose read returned `realtime: null` says so
   (`thread.liveOff`) and still reads and writes.
2. **A gap is re-read, never ignored.** The channel is at-most-once
   (`realtime/contract.fanout.md`). A `support.message` whose `seq` skips one,
   the client's `onMissed` after a reconnect, and the caller's own send each
   read `?afterSeq=<last held>` — the send because the status moved
   server-side (a `resolved` thread reopens on a message).
3. **Only this thread's events, only known shapes.** `readSupportEvent` drops
   an event naming another conversation, an unknown `kind` or a missing field.
   The channel strips `mine`; on the user's side `senderKind === "user"` is
   theirs. "Seen" moves forward on an agent's `support.read` only; typing shows
   for the event's `expiresInMs` and clears when the agent's message lands.
4. **A refused subscription is re-proved once.** An expired proof is refused
   like a forged one, so `onError` re-reads the latest page (a fresh proof)
   once; a second refusal turns live off for the page's life.
5. **Offered is what support accepts** (`threadActions`): write on every
   status but `closed`; rate a `resolved`/`closed` thread with no rating;
   reopen a `closed` one. Past the tenant's window support answers
   `reopen_expired`, and the page shows that sentence as it came.
6. **Typing is sent at most every 4s** (`typingGate`), below the server's ~6s
   hold, never for an empty box, and the gate resets after a send.
7. **The cursor moves only while the tab is visible**, 500 ms after the last
   message arrives — a background tab does not mark an agent's reply read.
8. **Files.** One message carries every picked file and the text as `body`
   (multipart — `api-request.ts` leaves a `FormData` body's own content type).
   The picker offers PNG, JPEG, WebP and PDF; size, count and quota are
   support's to refuse, in its own words. A file is a link only with a `url`
   (scanned clean, five minutes from the read); otherwise its scan state, or
   "removed" when retention `expired` it.

Every refusal is support's translated `msg` (`useApiErrorMessage`); the page
holds sentences only for statuses, scan states, sender kinds and its own
labels (`common.support.*`, every Prisma value covered — the spec reads
`support.prisma`).
