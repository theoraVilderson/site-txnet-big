---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-04
---

# Contract — panel-web: support — the user's (F-033-o), the agent's and admin's (F-033-p)

A topic file of [contract.md](contract.md) (§10). Two pages over
support-service's user routes and its `support:<id>` channel
([support contract](../../domains/support/contract.md), ADR-0112, ADR-0114).
The agent's side and the settings are under "Staff" below.

| Route | Component | What it does |
|---|---|---|
| `/support` | `support/_components/SupportView.tsx`, `NewTicketSheet.tsx` | the caller's conversations (newest activity first, `nextBefore` pages) under status tabs with counts and a search, both server-side in `?status=&q=` (`contract.ux.md` T2); the wait notice (`GET …/availability`); a new ticket in a sheet of steps — category (only when the tenant has any), optional subject (≤120), body (≤4000), files, the guides (T3); `?new=1` (`PANEL_SUPPORT_NEW`, the palette's "new ticket", UX-1-n) opens it, and closing it drops the query |
| `/support/[id]` | `support/_components/SupportThreadView.tsx` | one thread: messages oldest first, "earlier" (`beforeSeq`), sender by kind, files, "seen" on the caller's last message, the agent typing; send, attach (also by paste and drop), rate, reopen — drawn per `contract.ux.md` T4 (`ThreadParts.tsx`) |

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
8a. **A guide before the conversation** (F-414-k, `SupportGuideSuggestions.tsx`):
   the new ticket's last step shows up to 3 guides — those placed on
   `route:support`, then, once typing rests 500 ms, the ones subject + message
   match (`supportGuideQuery`, ≤ 100 characters; guide's `guide-search` with
   `match=any`). Each opens in place. An offer, never a gate: it never blocks
   sending, and a failed read shows nothing; with none, the step says so.

Every refusal is support's translated `msg` (`useApiErrorMessage`); the page
holds sentences only for statuses, scan states, sender kinds and its own
labels (`common.support.*`, every Prisma value covered — the spec reads
`support.prisma`).

## Staff (F-033-p)

| Route | Component | Who | What it does |
|---|---|---|---|
| `/support/inbox` | `SupportInboxView.tsx` | `support.agent` | the four views (`pending`, `live`, `mine`, `unassigned`) in support's queue order; priority, SLA badge, owner, unread; presence on/off; re-read every minute |
| `/support/inbox/[id]` | `AgentThreadView.tsx` | `support.agent` | messages and notes, take/release, priority, resolve, close; reply or note, canned insert; the user's sidebar (F-033-m); drawn per `contract.ux.md` T4 |
| `/support/settings` | `SupportSettingsView.tsx` | `support.manage` | tabs: working hours (`HH:MM`, `24:00` allowed, the tenant's zone), SLA targets per priority, categories (F-033-e) |

Menu: `support-inbox` and `support-settings`, each hidden without its
permission; the routes still answer 403 on their own. Rules:
`support/_lib/support-agent.ts`, pinned by `support/support-agent.test.ts`.

9. **The agent's thread re-reads on every `support.message`** — the channel
   carries the user's view (no `internal`, no `senderUserId`). Typing and
   "seen" are the user's only (`applySupportEvent(…, "agent")`), never a
   colleague's; "seen" sits on the last published agent message.
10. **A note never announces itself.** Typing is sent in reply mode only, a
    note is drawn dashed with "the user never sees it", and canned replies are
    offered for replies only (filled in the user's language by support).
11. **Presence is a heartbeat while an inbox page is open** (`usePresence`,
    30s; support forgets after 90s), so moving between inbox and thread never
    flaps. "Go offline" sends `away` and is remembered per browser
    (`localStorage`, a convenience — support's record is the beat).
12. **Offered is what support accepts** (`agentActions`): take a thread not
    already the caller's, release only one's own, resolve an unfinished one,
    close anything not closed (confirmed — final); a closed thread is
    read-only. Assigning to a named colleague waits on a staff list route.
13. **SLA badge** (`slaState`): breached is support's verdict or a running
    clock past due; "soon" within 30 minutes; no `dueAt` is "waiting on the
    user", never due. Settings refuse locally what support would
    (`slaFormErrors`, `0 < first ≤ resolution ≤ 43200`), and every category
    write re-reads the list, since one can flip `usingPlatform`.
