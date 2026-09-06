---
id: adr-0015
status: accepted
updated: 2026-09-06
---

# ADR 0015 — an account-switch group is scoped to the surface it was built on

- **Status:** accepted
- **Date:** 2026-09-06
- **Affects units:** audit, identity, auth-api, panel-web, bot-app

## Context

`F-0205`…`F-0210` shipped account switching on both surfaces. The group was a
property of the **person**: `audit.linked_account_member.userId` was globally
`@unique`, so one account belonged to at most one group anywhere, and every
surface read the same one.

That turned out to be the wrong unit of ownership, and the report that showed
it was mundane: the bot listed an account the user had never signed into there.
Nothing was broken — the pair had been proved once from the panel that morning,
and the bot was faithfully reading the same group. But "faithfully" is the
problem. The two surfaces are not two windows onto one workspace. A Telegram
chat is a place with its own audience; a browser is another. A person who runs
a family member's account from their phone and a resale account from their
laptop was being told those are the same set, because they are the same human.

The second, quieter consequence: `F-0208` ("remove an account from the group")
was still `todo`, so a wrong add was permanent. That is tolerable when there is
one set. It is not once a person maintains several.

## Decision

**A switch group belongs to the surface instance it was built on.**

`LinkedAccountMember` gains a `scopeKey`, and the uniqueness moves onto the
pair:

| scope | key | derived from |
|---|---|---|
| a bot chat | `bot:<platform>:<chatId>` | a verified `x-service-token` + `x-bot-chat-id` + `x-bot-platform` |
| a browser | `device:<uuid>` | a server-minted, httpOnly `device_id` cookie |

`userId @unique` → `@@unique([scopeKey, userId])`. The caller's group *in this
scope* is the row `(scopeKey, callerUserId)`, and its `groupId` is the set.
Listing, switching, adding and removing all read the same scope.

`F-0208` is implemented in the same change, on both surfaces, and works **from
either side**: any member may remove any other, and may remove itself.

### Sessions carry the scope too

`identity.session` gains a nullable `scopeKey`, stamped at mint time and
**carried forward** by `refresh`. `F-0208` then revokes only the removed
account's sessions *in the removing scope*
(`SessionService.revokeSessionsForUserInScope`).

The spec-literal alternative — revoke that account everywhere — was rejected as
actively wrong under this ADR: it would let whoever holds a browser sign an
account out of a Telegram chat where it is still a legitimate member of a
different group. That is a denial of service dressed as a cleanup. The narrow
revoke still answers the case `F-0208` names (a lost or recycled phone number),
because the session that must not survive the removal is the one on the surface
the removal happened on.

## Why the member row and not the group

Keying the *group* to the device was the obvious shape and is wrong. A device
would then have one group, and a second account signing in on that device would
have to either join it automatically — a takeover, since anyone who can log
into that browser inherits the switcher — or be locked out of adding at all.

Keying the **member row** leaves audit invariant #4 exactly as it was: nothing
joins without proving itself, and two accounts used on one device simply hold
two different sets.

The platform must be in the bot key because a Telegram chat id and a Bale chat
id are integers from unrelated namespaces and can collide. A service caller
that sends a chat id with no platform gets **no** scope, and the routes answer
`ok:false` rather than guess a messenger.

## Consequences

- **A `device_id` cookie is not a credential.** It is a partition key, and
  forging one from a browser buys nothing: membership still has to exist under
  it, and membership is only ever written after an account proves itself. This
  is why it is an ordinary httpOnly cookie and not something signed.
- **Clearing cookies loses the browser's group**, and that is the intended
  reading: a browser that cannot be recognised is a different place. The
  accounts themselves are untouched; the set is rebuilt with one click each.
- **The same account may now be in several groups at once** — one per surface.
  Audit invariant #3 is rewritten accordingly: joining is still a *move*, but
  only within a scope.
- **Existing rows** were backfilled to the inert key `legacy:panel`, which no
  live browser or chat matches. History is kept and the pre-existing group
  reads empty everywhere until it is re-added. This was dev data; there is no
  production deployment yet and `prisma/migrations/` does not exist
  (`docs/operations/migrations.md`, D-5).
- **`refresh` is the sharp edge.** It revokes and re-mints, so it must copy the
  old row's `scopeKey`. The panel refreshes on every page load, so a re-mint
  that dropped it would detach the session from its group within seconds, and a
  re-derive would move a session between scopes whenever the request changed.
  Pinned by a test in `auth.service.spec.ts`.
- This supersedes the shared-group assumption that `F-0205`…`F-0210` and
  ADR-0014 were written under. ADR-0014's own decision — in the bot the session
  moves and the link does not — is unaffected and stays `accepted`.

## Alternatives considered

- **Leave it global, add `F-0208` only.** Cheapest, and it answers the "wrong
  add is permanent" half. It does not answer the report at all: the bot would
  still list an account the user never signed into there.
- **Scope to the platform, not the instance** (`bot:telegram` vs `site`). One
  bucket per surface *kind*. Simpler key, but two Telegram chats belonging to
  different people would share a group, which is worse than what we started
  with.
- **Add `Session.scopeKey` but keep groups global.** Would make the revoke
  precise without changing what a group is — precision about the blast radius
  of a removal, while leaving the thing being removed wrong.
