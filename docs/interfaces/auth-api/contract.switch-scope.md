---
id: auth-api
layer: interface
status: active
version: 18
updated: 2026-09-10
---

# auth-api — switch scope

Which surface instance an account-switch group belongs to, and where a given
call's answer comes from. Split out of [contract.md](contract.md) at 250 lines
(§10): it is one cross-cutting rule that every `/auth/accounts/*` row depends on
and none of them restates.

The decisions behind it: [ADR-0015](../../architecture/decisions/0015-an-account-switch-group-is-scoped-to-the-surface-it-was-built-on.md)
(a group belongs to the surface it was built on),
[ADR-0032](../../architecture/decisions/0032-a-session-carries-its-switch-scope-and-the-mini-app-inherits-the-chats.md)
(a session carries its scope; the Mini App inherits the chat's),
[ADR-0034](../../architecture/decisions/0034-a-switch-moves-the-place-and-the-place-remembers-it.md)
(a switch moves the place and the place remembers it),
[ADR-0035](../../architecture/decisions/0035-logging-out-of-an-account-falls-back-onto-the-place.md)
(logging out of an account falls back onto the place).

Every `/auth/accounts/*` route acts on the group of the *surface* the call came from, never a global
one, and the scope is never in a request body. These routes are all
authenticated, so it is **the scope stamped on the caller's session**, not
one re-derived per request (2026-09-10; unstamped falls back to the request).
The routes that *mint* sessions still read it from the request: a browser's
httpOnly `device_id` cookie (domain-wide, one year, minted on the first
response that lacks it), or `bot-service`'s `x-service-token` plus
`x-bot-chat-id` **and** `x-bot-platform` — a chat id with no platform gets no
scope and is refused (`accountSwitch.noScope` on the adds, `notAMember`
elsewhere). Consequence: a Mini App session's scope is the **chat's**.
