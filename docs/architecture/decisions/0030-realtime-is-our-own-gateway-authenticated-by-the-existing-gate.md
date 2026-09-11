---
id: adr-0030
status: accepted
updated: 2026-09-10
---

# ADR 0030 — Realtime is our own WebSocket gateway, authenticated by the gate that already exists

- **Status:** accepted
- **Date:** 2026-09-10
- **Affects units:** realtime, forward-auth, identity, support, panel-web

## Context

`D-9` asked what carries realtime to the browser, and was answered on
2026-09-04 with **Centrifugo, its own service in the swarm**. That answer was
reversed on 2026-09-10, on the user's call.

The objection raised at the time was that Centrifugo's admin panel is not
multilingual. That is a thin reason to own a realtime server, and it is not the
reason this ADR records — an ops-only UI is the cheapest thing on the list to
work around. What decides it is the **identity model**.

A third-party realtime server does not know who our users are. Every one of
them solves that the same way: the application mints a second token, in the
server's own format, with its own lifetime, its own signing key and its own
revocation story, and hands it to the browser. That is a parallel
authentication system — a second place a session can be live after `identity`
has revoked it, a second secret to rotate, and a second answer to "may this
person hear this?" that has to be kept in step with `forward-auth`'s policy
file by hand.

This platform already terminates every request at Traefik and runs it through
`forward-auth`, which validates the access JWT, confirms the session marker in
Redis and enforces the RBAC policy (ADR-0004). **A WebSocket upgrade is an HTTP
request**, so it goes through that same middleware with no special case. The
cost of owning the gateway is one small deployable; the cost of not owning it
is a second identity model. That trade is what reverses D-9, and it is why
"build it ourselves" is the cheap option here rather than the expensive one.

One thing did not survive contact with the decision. The premise as written was
that the upgrade "needs no second identity model" because it goes through the
gate like everything else — true — but `forward-auth` reads
`Authorization: Bearer`, and a browser cannot set headers on
`new WebSocket()`. `panel-web` holds its access token in a module variable and
calls `api.<domain>` directly, so there is no proxy hop to add one either.
Something had to give.

## Decision

**Realtime is a first-party WebSocket gateway (`platform/realtime`, deployed as
`gateway-service`), and the upgrade is authenticated by `forward-auth`.**

Three parts, each of which was a live alternative:

1. **The token rides in `Sec-WebSocket-Protocol`.** It is the one header a
   browser lets a page choose, as `new WebSocket(url, ["txnet.v1", jwt])`.
   `forward-auth` accepts a token from that list in addition to
   `Authorization`, anchored: the marker must be the first entry and the token
   the second. The server selects `txnet.v1` in the handshake response and
   never the token, so the credential is not echoed into a response header.

   *Rejected:* a short-lived ticket redeemed in the query string. It works, and
   it is the common pattern, but it puts the check inside `gateway-service`
   rather than at the gate — which is precisely the second identity model this
   ADR exists to avoid, arrived at from the other direction. *Also rejected:*
   an unauthenticated upgrade with auth as the first frame, which leaves an
   anonymous connection open for a window and moves the check past the gate in
   the same way.

2. **`forward-auth` forwards `X-Session-Id`.** A socket outlives by hours the
   ~15-minute access token that opened it, so a decision taken once at the
   upgrade is not enough. The gateway re-reads `session:<id>` on a timer and
   closes the connection when the marker is gone — the same question
   `forward-auth` asks per request, with the same rule for the answer: a
   missing marker means revoked, never "unknown, allow". None of the existing
   identity headers name a session, so this one is added and stripped from
   inbound requests like every other.

3. **One connection per user, multiplexed into channels**, with the
   subscription cap and the heartbeat present from the first version. Both are
   cheap now and breaking later: a cap added after clients have grown past it
   breaks them, and a protocol without a heartbeat cannot acquire one without a
   version bump.

## Consequences

- There is exactly one place a session is live. Sign-out, admin revocation and
  keyspace-version bumps all reach the socket without any code that knows what
  a socket is.
- `gateway-service` holds no JWT secret, no database and no tenant credential,
  the same shape `bot-service` has (ADR-0009). Its only dependency is the Redis
  holding `session:<id>`.
- `forward-auth` gains a second accepted token source. It is additive — an
  `Authorization` header still wins — so it is a patch, not a version bump
  (`00-PROTOCOL.md` §8), and its two consumers are unaffected.
- **The window between revocation and the socket closing is real**, bounded by
  `REALTIME_SESSION_RECHECK_MS` (60s). Closing it entirely would need Redis
  keyspace notifications or a revocation event on the broker; a bounded window
  is the honest cost of a periodic check, and it is stated rather than assumed.
- The gateway is per-replica: it can only deliver to connections it is holding.
  Reaching the replica that holds a given user is F-067-i, and it is a
  prerequisite for running more than one.
- A deployment whose Traefik `authResponseHeaders` list is not updated forwards
  every header but `X-Session-Id`. The gateway refuses the upgrade in that case
  rather than running without the re-check — a failure that is loud on the
  first connection instead of silent for the life of a session.
