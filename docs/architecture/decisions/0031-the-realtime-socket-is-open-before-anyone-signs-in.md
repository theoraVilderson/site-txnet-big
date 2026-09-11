---
id: adr-0031
status: accepted
updated: 2026-09-10
---

# ADR 0031 — The realtime socket is open before anyone signs in

- **Status:** accepted
- **Date:** 2026-09-10
- **Affects units:** realtime, forward-auth, identity, auth-api, panel-web
- **Amends:** ADR-0030, which assumed every socket belongs to a signed-in user.

## Context

ADR-0030 built the WebSocket gateway on one premise: a socket is a signed-in
user's, so the upgrade goes through `forward-auth` like every other request and
there is no second identity model. That premise held for everything the row in
front of it needed, and it is still the right premise for most channels.

F-067-j is the case it does not cover. The OTP delivery result has to reach the
browser that asked for a code, and the three routes that issue one — `register`,
`login/otp/request`, `password/forgot` — have no session by definition. There is
nobody to be signed in as. Under ADR-0030 that upgrade is refused at the gate,
so the result cannot be pushed and the client is left polling the status route
D-15 kept as a *fallback*.

The user's call, on 2026-09-10, was broader than that one feature: the socket
should be connected essentially all the time, whether or not anyone has signed
in, because a WebSocket here is the platform's live-data transport rather than a
feature of the panel. That reading makes the pre-login case the normal one and
the signed-in case a refinement of it.

ADR-0030 had already considered and rejected two ways to admit such a caller,
and both rejections still stand:

- **A short-lived ticket redeemed in the query string**, checked inside
  `gateway-service`. Rejected because it moves the decision off the gate, which
  is the second identity model that ADR exists to avoid.
- **An unauthenticated upgrade with auth as the first frame.** Rejected for the
  same reason, plus an anonymous connection held open for a window.

So the question this ADR answers is not "may an anonymous socket exist" — the
user decided that — but *where the decision about it is made*.

## Decision

**The gate admits a caller with no credential, and a channel that no identity
covers is authorized by a proof presented per subscription.**

Three parts:

1. **`forward-auth` gains `/validate-optional`**, and the realtime router uses
   it through a second Traefik middleware (`my-auth-optional`). It is the same
   decision as `/validate` for a caller that brought a credential and a 200
   identifying nobody for one that did not. The check stays at the gate, so
   neither rejected alternative comes back: there is still exactly one place a
   token is validated and a session is checked.

   **Absent is anonymous; invalid is still 401.** A credential that was
   presented and failed is never downgraded. Downgrading would turn an expired
   token into a silent loss of privilege — a page that shows nothing rather than
   one told to sign in again — and would let a caller reach an admitted state by
   corrupting its own token.

   The gate marks the anonymous answer with `X-Auth-Anonymous: true`, forwarded
   and stripped like every identity header. Without it "nobody is signed in" and
   "the middleware never ran" are the same thing downstream, and a router that
   lost its middleware would turn every authenticated socket into an anonymous
   one — visible to a user only as a panel that quietly stopped updating.

2. **A connection may have no identity.** `gateway-service` accepts one, gives
   it no `user:` or `tenant:` channel, and caps it by client address rather than
   by user — `REALTIME_MAX_CONNECTIONS_PER_IP`, since the per-user cap has no
   key to count against. Anonymous connections are not session re-checked;
   there is no session to revoke.

3. **A third channel family, `otp:<channelId>`, authorized by a token.** The
   proof is minted with the delivery handles when a 202 is answered, stored in
   Redis under the OTP's own TTL, and handed to the one client that asked. The
   gateway compares it in constant time and consults no identity at all.

   The channel id is **not** the delivery id, though they are minted together
   and are both 128 bits. A channel name reaches Redis pub/sub, gateway logs and
   metrics; the delivery id is the capability that reads the status. Reusing one
   value would put the capability into all of those places for nothing.

   The event carries `sent` / `failed` and never the code
   (`identity/invariants.md` #2).

## Consequences

- **ADR-0030's principle survives; its premise does not.** There is still one
  gate, one token format, one session store and one place a session is live. What
  changed is that "no credential" is now an answer the gate can give, rather than
  a refusal.
- **The blast radius of the anonymous path is bounded by what it can reach**: no
  identity-scoped channel, and only channels whose proof it already holds. An
  attacker who bypasses Traefik entirely and forges `X-Auth-Anonymous` gains an
  anonymous connection, which is what they could have had by connecting
  normally.
- **An address is a blunt cap key.** It lumps everyone behind one NAT into one
  budget and it moves when a phone changes network. It is a ceiling on abuse,
  not a quota, and the default is set accordingly. A better key would need
  something the anonymous caller does not have.
- **The proof check touches Redis on every `otp:` subscribe.** It is one `GET`,
  guarded by a shape check so a malformed name cannot turn into a read, and it
  is the only channel family whose authorization leaves the process.
- **A proof-bearing channel cannot be resumed.** The `resume` frame carries no
  proofs, and giving it somewhere to keep them would be the server-side resume
  state ADR-0030 deliberately does not have. The client re-subscribes
  explicitly; it is holding the proof already.
- **The status route stays, and is still the record.** D-15 made it the fallback
  for a client that reconnects or never opened a socket, and a pushed event is
  at-most-once. Nothing here makes the socket the truth.
- `panel-web` can now hold one socket from the moment a page loads and keep it
  across sign-in, at the cost of reconnecting once when it acquires a token —
  the identity headers are decided at the upgrade and a connection does not
  acquire them later.
