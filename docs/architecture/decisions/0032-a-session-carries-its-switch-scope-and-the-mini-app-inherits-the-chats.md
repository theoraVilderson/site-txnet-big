---
id: adr-0032
status: accepted
updated: 2026-09-10
---

# ADR 0032 — a session carries its switch scope, and the Mini App inherits the chat's

- **Status:** accepted
- **Date:** 2026-09-10
- **Affects units:** identity, auth-api, redis-keyspace, panel-web, bot-app
- **Amends:** [ADR-0015](0015-an-account-switch-group-is-scoped-to-the-surface-it-was-built-on.md)

## Context

ADR-0015 made an account-switch group a property of the **place** it was built
on rather than of the person: `bot:<platform>:<chatId>` for a chat,
`device:<uuid>` for a browser. The reasoning was about audience — a Telegram
chat is a place with its own audience, a browser is another — and it is still
right.

The Mini App (`F-310`, [ADR-0017](0017-the-mini-app-signs-itself-in-with-the-signature-the-platform-hands-it.md))
landed two days later and does not fit that split. It is a browser, so it takes
`device:<uuid>` — a *third* scope, distinct from both the chat it was opened
from and the user's own laptop. A person adds an account in the bot, taps
"open the app" in the same chat, and the switcher is empty. Adding it there
instead does not show up in the chat either.

That is not the case ADR-0015 was protecting. The Mini App is not another place
with another audience: it is **the same chat, the same person, the same
moment**, rendered as a webview. Whoever can open it is exactly whoever can
read the chat.

`bot-session.service.ts` already recorded this as a known compromise rather
than an oversight: minting under the chat's scope was rejected at the time
because *later* calls could not see it. `/auth/accounts`, switch, add and
remove all re-derive the scope from the request — the `device_id` cookie for a
browser — so a session minted under `bot:telegram:123` would list a group whose
own follow-up calls looked somewhere else.

ADR-0015 named that re-derivation as the sharp edge in its own Consequences:
*"a re-derive would move a session between scopes whenever the request
changed"*. It fixed the instance it had (`refresh` re-minting) by **carrying
`scopeKey` forward** on the session, and left the general case alone.

## Decision

**Two halves, and the first is what makes the second possible.**

### 1. For an authenticated call, the session's scope wins

`identity.session.scopeKey` is stamped at mint time (ADR-0015). It now decides
the scope of every authenticated request, rather than being re-derived from the
request:

| the call | where its scope comes from |
|---|---|
| unauthenticated (login, register, `bots/webapp/session`) | the request — the `device_id` cookie, or the bot headers. Unchanged |
| authenticated (`/auth/accounts`, switch, add, remove) | **the session's own `scopeKey`** |

`SwitchScopeMiddleware` still runs on every route and still mints the cookie,
because the cookie has to exist before the first authenticated call is made.
`AuthGuard` then overrides its answer with the session's. A session with no
`scopeKey` falls back to the request's, so nothing that predates this changes
behaviour.

The fast path carries it: the Redis marker `session:<id>`, which `AuthGuard`
already reads on every request, gains `scopeKey` alongside `userId`. No extra
round trip, and Postgres stays the source of truth.

### 2. A Mini App session is minted under the chat's scope

`POST /auth/bots/webapp/session` verified the platform's signature to learn
*which messenger account* is looking. That same verified `initData` names the
chat, so the session is minted under `bot:<platform>:<chatId>` — the scope the
conversation the page was opened from already uses.

With (1) in place, the follow-up calls agree: the switcher the Mini App shows
is the chat's switcher, an account added in one appears in the other, and a
removal from either is a removal from the pair.

## Consequences

- **The bot and its Mini App are one place.** That is the intended reading and
  the whole point of the change. The user's own browser is still a separate
  place, and two chats are still separate from each other.
- **A Mini App session is revoked by an `F-0208` removal in the chat**, because
  `revokeSessionsForUserInScope` now finds it under the same key. Correct: the
  chat is where that person's membership lived.
- **The `device_id` cookie still gets minted in the webview** and is simply
  unused for the group. Harmless, and cheaper than special-casing the mint.
- **A session minted before this ships has no `scopeKey` in Redis** until it
  refreshes. It falls back to the request's scope — exactly today's behaviour —
  so the change rolls out without a flush.
- **The bot's own `/auth/bots/session` is untouched.** It is a service call
  with the chat headers, so its scope was already the chat's.
- **This narrows what a forged `device_id` could ever have reached**, which was
  already nothing (ADR-0015: it is a partition key, not a credential). An
  authenticated caller can no longer point at a different partition by
  swapping the cookie mid-session.

## Alternatives considered

- **Put `scopeKey` in the access token.** Zero I/O and no keyspace change. It
  makes the scope a claim, which means a 15-minute window where a revoked or
  moved scope is still honoured, and it widens a token shape `forward-auth`
  parses. The marker is read on every request anyway.
- **Make the Mini App send the chat id as a parameter.** The page would be
  naming its own partition, which is the one thing ADR-0015's "partition key,
  not a credential" reasoning survives only because membership is proved
  separately. The verified `initData` already carries the chat; asking the
  client for it again adds a lie the server would have to check.
- **Leave the scopes separate and sync the two groups.** Two sources of truth
  for one set, plus a reconciliation nobody asked for. The groups are not two
  things that should agree; they are one thing that was split by accident.
- **Give the Mini App no switcher at all.** Honest, and much cheaper. Rejected
  because `panel-web` is `panel-web` (ADR-0009): a screen that works worse
  inside the messenger than outside it is the thing the Mini App exists to
  avoid.
