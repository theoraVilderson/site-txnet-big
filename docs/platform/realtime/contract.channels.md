---
id: realtime
layer: platform
status: active
version: 2
updated: 2026-09-13
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
colon, so extra colons cannot widen a match. Six families exist; anything
else is `realtime.channelUnknown`, because an unknown prefix is not a channel
with no rule yet.

| Channel | Who may subscribe |
|---|---|
| `user:<userId>` | that user, and only that user |
| `tenant:<tenantId>` | a connection in that tenant holding `realtime.tenant.read` |
| `otp:<channelId>` | anyone presenting the `proof` minted with that delivery — signed in or not |
| `support:<conversationId>` | a signed-in connection presenting the `proof` support-service minted **for that user** (F-034, ADR-0114) |
| `members:<tenantId>` | any signed-in connection whose tenant is that id — no permission; body is `type` + ids only (RT-1-k, [contract.live-events.md](contract.live-events.md)) |
| `catalog:<tenantId>` / `catalog:platform` | the first: any signed-in connection whose tenant is that id; the second (`PLATFORM_CATALOG_ID`): any signed-in connection — no permission; body is `type` + a variant id (RT-1-p) |

**`user:`, `tenant:`, `members:` and `catalog:` refuse an anonymous connection by
construction.** There is no id to compare, and "no id" must never compare
equal to a channel's.

**`members:` asks no permission, and still matches the tenant exactly**
(RT-1-k, user 2026-10-06). It carries what reaches a whole tenant, staff or
not — the body says only that something changed. The platform's members
include its resellers' accounts on the platform domain; a reseller's own users
are another tenant and never hear the platform's channel, nor it theirs.

**`catalog:platform` is open to every signed-in connection** (RT-1-p, user
2026-10-18). Every tenant's shop sells the platform's products, so a move on one
of them is one event however many resellers sell it — a row per reseller would
grow with the platform, on the purchase path. The gateway holds no database, so
the platform's catalog is named by a fixed word, not its tenant id. What leaks
is that a platform variant's counts moved, by id; the page re-reads through its
own RLS, which hides a product the reseller's package does not list.

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

**`support:` needs an identity *and* a proof** (F-034, ADR-0114).
support-service mints the proof on a read of the thread, after its own check
of who may see it, at `support:channel:<conversationId>:<userId>`. The gateway
reads that key for the connection's own `userId` — a proof copied to another
account names a key that does not exist — and checks the id is a UUID before
asking Redis, as for `otp:`. Not resumable: the client re-subscribes with the
proof from its next read of the thread.

**No permission grants another person's `user:` channel.** An admin with every
permission on the platform still cannot listen in here — acting as someone else
is impersonation, and impersonation leaves an `audit` row (`/auth/users/:userId/impersonate`).
A permission that skipped that would make it invisible.

**A `tenant:` channel needs the permission *and* an exact tenant match.** The
permission alone would let a permitted operator at one reseller name another
reseller's id, which is the tenancy boundary (ADR-0023).

