---
id: realtime
layer: platform
status: active
version: 2
updated: 2026-09-10
---

# Contract — realtime channels

Who may hear what. A §10 split from `contract.md`, which was at 270 lines after
ADR-0031 gave a channel two ways to be authorized; the frames, the connection's
own lifecycle and the limits stay there, and the transport is in
[contract.fanout.md](contract.fanout.md).

This is the security surface of the unit. Everything else about a socket
announces its own failure — a bad frame is answered, a dead heartbeat closes
the connection, a refused upgrade never opens one. A channel authorized too
loosely works perfectly for the person testing it and delivers someone else's
events to a stranger, with no error anywhere. `channel.spec.ts` is the spec
that pins it.

A channel name is `<family>:<id>`. The id is everything after the **first**
colon, so extra colons cannot widen a match. Three families exist; anything
else is `realtime.channelUnknown`, because an unknown prefix is not a channel
with no rule yet.

| Channel | Who may subscribe |
|---|---|
| `user:<userId>` | that user, and only that user |
| `tenant:<tenantId>` | a connection in that tenant holding `realtime.tenant.read` |
| `otp:<channelId>` | anyone presenting the `proof` minted with that delivery — signed in or not |

**The first two refuse an anonymous connection by construction.** There is no
id to compare, and "no id" must never compare equal to a channel's.

**`otp:` is authorized by a proof, not by an identity** (F-067-j, ADR-0031).
The three routes that issue an OTP have no session, so there is nothing to
scope such a channel to; what the client has instead is a token the 202 handed
it. The gateway reads the token Redis holds for that channel id, compares it in
constant time, and consults identity not at all — a signed-in connection
holding the proof is as entitled as an anonymous one, and a signed-in
connection without it is not entitled at all.

Two properties of that family are worth stating because they are easy to
weaken later:

- **An expired channel and one nobody ever minted are the same refusal.** The
  OTP routes mint handles whether or not a code was really issued, so any
  answer that told the two apart would restate, over a socket, the account
  existence those routes exist to refuse.
- **The id is checked for shape before Redis is asked anything.** This is the
  only family whose authorization leaves the process, so a name that could not
  be an id must not become a read — otherwise a client chooses how much work
  this gateway does by sending nonsense.

**No permission grants another person's `user:` channel.** An admin with every
permission on the platform still cannot listen in here — acting as someone else
is impersonation, and impersonation leaves an `audit` row (`/admin/impersonate`).
A permission that skipped that would make it invisible.

**A `tenant:` channel needs the permission *and* an exact tenant match.** The
permission alone would let a permitted operator at one reseller name another
reseller's id, which is the tenancy boundary (ADR-0023).

