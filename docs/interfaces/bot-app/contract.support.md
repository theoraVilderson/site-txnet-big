---
id: bot-app
layer: interface
status: active
version: 14
updated: 2026-10-04
---

# Contract — bot-app: support in the chat (F-309)

A topic file of [contract.md](contract.md). `flows/support.flow.ts`, the
`💬 Support` row on the member menu (`ACTIONS.support`), `flows/chat-files.ts`
and `support-api/support-api.client.ts` — the panel's own `/api/support/*`,
through the gate (`SUPPORT_API_BASE_URL`, chat access token as Bearer), so a
conversation started in the chat is the one the panel shows and an agent
answers (ADR-0009, ADR-0112). The rules are support's
([contract.md](../../domains/support/contract.md)).

## Rules

1. **The bot decides nothing.** Which threads are the user's, what may be
   sent, what a status means and whether a rating or a reopen is taken are
   support's. A refusal is told by its `error.reason` in the bot's own
   sentence (`SUPPORT_REFUSAL_KEYS`, every one a member of support's
   `ConversationRejection`), else support's translated `msg`.
2. **The row is behind support's reachability** (`SupportApiClient.isConfigured`).
3. **List → thread.** The list is the user's threads (≤10, newest activity
   first), each `subject · status · n new`, then `✍️ New request`. New asks a
   category only when the tenant has one, then the text (`support.compose`),
   then opens the thread.
4. **A thread** shows its latest 6 messages, each cut at 500 characters (the
   panel has them whole), and is marked read up to its `lastSeq` — looking is
   reading, as on the panel. Its state is `support.thread` + the id: typed text
   goes to it as a reply; a photo or a document as an attachment, its caption
   as the text.
5. **Buttons name their thread** (`sup:<kind>:…`, ≤64 bytes), so a tap on an
   old screen still means what it says and needs no state: `o` open/refresh
   (`supportOpenCallback`, shared-core — the one a notice carries), `c`
   category, `f` a file (both ids as 22-character base64url), `r` rate 1–5, `x`
   reopen, `sup:n` new.
6. **A file button exists only for a file support will hand over** — `clean`
   and not expired — at most 5. Tapping it fetches the bytes through
   support's `GET …/attachments/:attachmentId` and sends them as a document
   after the thread (`FlowResult.document`). Never the signed `url`: it is a
   path on the tenant's own panel Host, which a reseller's bot does not know.
7. **Rate** only on a `resolved`/`closed` thread with no rating; **Reopen**
   only on a `closed` one. Each answer shows the thread again.
8. **A file the user sent** is fetched from the platform it arrived on
   (`getFile`, ≤20 MB, `ChatFiles`) and handed to support as sent — a photo as
   `photo.jpg`/`image/jpeg`; support sniffs and decides. One the platform
   would not hand over is `support.fileUnreadable`, never sent as nothing. A
   file outside a thread is `support.fileOutside`; one while composing,
   `support.composeFileFirst`.
9. **Text a person wrote** (subject, message, file name) is data, never
   interpolated; the renderer escapes every message for HTML (messenger).
10. **Notices.** An agent's reply or resolve also reaches the user's chats
    (support's `SupportNotifier`, auth-api's `supportReplied`/`supportResolved`
    on `bot`), with an Open button that lands in the thread, ready for the
    answer.
11. **A guide before the conversation** (F-414-k): the compose prompt lists up
    to 3 guides placed on `bot_screen:support`; a typed message is matched
    (`GuideApiClient.search`, `match=any`) and, when guides match, offered —
    up to 3 `gk:` buttons and `sup:s` "Send it anyway" — before anything opens,
    the message kept as `support.suggested` (nav state, 30 min). A guide opened
    from the offer keeps it and "Send it anyway" (`keepDraft`); a new message
    replaces it. No match, or guides unreachable: it opens at once, as before.

## Not here

Agents answer from the panel (F-033-p); typing, presence and the live socket
are the panel's. Older messages than the latest page are in the app.
