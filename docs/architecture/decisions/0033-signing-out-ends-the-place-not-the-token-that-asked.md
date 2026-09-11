---
id: adr-0033
status: accepted
updated: 2026-09-10
---

# ADR 0033 — signing out ends the place, not the token that asked

- **Status:** accepted
- **Date:** 2026-09-10
- **Affects units:** identity, auth-api, bot-app, panel-web
- **Builds on:** [ADR-0032](0032-a-session-carries-its-switch-scope-and-the-mini-app-inherits-the-chats.md)

## Context

ADR-0032 made a bot chat and its Mini App one place: one switch scope, one
account-switch group. It did not say anything about signing out, and the gap
showed up on the first try — log out of both accounts inside the Mini App, send
`/start`, and the bot carries on signed in.

Two separate things were wrong, and only fixing both makes the behaviour whole.

**`/auth/logout` revoked one row.** It looked the session up by the refresh
token it was handed and revoked exactly that. But a place can hold more than
one session for the same account: the chat holds one (minted by
`/auth/bots/session`, no user agent) and the Mini App holds another (minted by
`/auth/bots/webapp/session`, a browser user agent), both now under
`bot:<platform>:<chatId>`. Signing out of one said nothing about the other.

**The bot's menu trusted a local cache.** `bot:session:<platform>:<id>:<chat>`
in Redis holds the chat's refresh token, and `ConversationRouter.menu()` read
it directly: an entry meant "signed in". Nothing local can know that session
was revoked somewhere else, so the bot answered a signed-out user with the
member menu and only discovered the truth on the first tap — via `ChatAccess`,
which was already doing the right thing everywhere except here.

## Decision

**1. A logout revokes every live session that account holds in the session's
own scope.**

The scope is read off the row the refresh token resolved to, never off the
request: `/auth/logout` is public — it reads a cookie, not a `Bearer` — so the
request cannot be trusted to name the place it is signing out of. A session
with no `scopeKey` (impersonation, or anything minted before ADR-0015) matches
no place and falls back to revoking itself.

It reuses `SessionService.revokeSessionsForUserInScope`, written for `F-0208`
with exactly this blast radius: this account, this place, nowhere else.

**2. The bot's menu asks `ChatAccess`, not the Redis entry.**

`ChatAccess.token()` refreshes before answering, so a session revoked anywhere
fails there and the dead entry is dropped in the same call. The menu is now the
same authenticated screen every other one is, instead of the one screen that
believed a cache.

## Consequences

- **A Mini App logout signs the chat out, and a `/logout` in the chat signs the
  Mini App out.** That is the reading ADR-0032 already committed to; this is
  the half that was missing.
- **A menu render costs one round trip** (`/auth/refresh`) where it used to
  cost a Redis read. Every other authenticated screen already paid it, and
  refreshing rotates the token, which the entry has always handled.
- **In a browser this changes almost nothing.** A `device:<uuid>` scope holds
  one live session for an account, so revoking "all in scope" revokes the one
  that asked — the behaviour it already had.
- **Logging out is now the way to end a shared place deliberately**, which is
  worth saying out loud: a person who signs out in the Mini App because they
  are handing their phone over also loses the chat, and that is the point.
- **Not extended to `F-0207` switch.** A switch already revokes the caller's
  session and mints a replacement in the same scope; widening it would revoke
  the session it is in the middle of replacing.

## Alternatives considered

- **Leave logout narrow; only fix the menu.** The bot would then keep a
  genuinely live session after a Mini App logout, so `/start` would correctly
  show the member menu — correct, and still not what the user meant by "log
  out". It fixes the lying menu without fixing the lie.
- **Revoke every session for the account, everywhere.** The spec-literal
  reading, and the same denial of service ADR-0015 rejected for `F-0208`: a
  browser could sign an account out of a Telegram chat it has no authority
  over.
- **Have the bot subscribe to a revocation event.** The only design that keeps
  the menu at one Redis read. It buys a broker dependency, an at-most-once
  delivery and a new failure mode for a screen that is rendered a handful of
  times per conversation, to save a call the same conversation makes on every
  other screen.
