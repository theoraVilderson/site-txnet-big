---
id: realtime
layer: platform
status: active
version: 2
updated: 2026-09-10
---

# Contract — realtime

One WebSocket per client, multiplexed into channels. Deployed as
`gateway-service`. See ADR-0030 and ADR-0031.

## TL;DR

The browser opens `wss://api.<domain>/realtime`, with the access JWT as a
second subprotocol if it has one. Traefik runs the upgrade through
`my-auth-optional` like every other request, so `forward-auth` makes the one
decision: identity headers for a signed-in caller, `X-Auth-Anonymous` for a
caller carrying nothing, a refusal for a credential that failed. The gateway
reads that answer, accepts the socket, and from then on the client subscribes
to channels it is allowed to hear — by who it is, or by a proof it presents.
Events reach it from other processes over Redis pub/sub —
[contract.fanout.md](contract.fanout.md).

## Opening a connection

```js
// signed in
new WebSocket(`wss://api.${domain}/realtime`, ['txnet.v1', accessToken]);
// not signed in — the ordinary case on a login or registration page
new WebSocket(`wss://api.${domain}/realtime`, ['txnet.v1']);
```

The token rides in `Sec-WebSocket-Protocol` because it is the only header a
browser lets a page set on an upgrade, and `panel-web` holds its access token
in memory with no proxy hop that could add an `Authorization` (ADR-0030). The
list is matched exactly — `txnet.v1` first, the token second — and the server
selects `txnet.v1`, never the token: a selected subprotocol is echoed on the
101, and echoing the credential would write it into a response header for
nothing.

**A socket with no token is a real connection, not a degraded one** (ADR-0031).
It hears no `user:` or `tenant:` channel, because there is nobody to scope one
to, and it hears any channel it can present a proof for. That is what makes the
OTP delivery result reachable during registration, when by definition no
session exists.

| Outcome | What it means |
|---|---|
| `101` + `Sec-WebSocket-Protocol: txnet.v1` | connected — signed in or anonymous; the `welcome` frame says which |
| `401` | a token was presented and failed, or the gate said nothing at all. Refresh the access token and retry **once**. Retrying *without* the token connects anonymously, which is the right move only if the page can work that way |
| `429` | at `REALTIME_MAX_CONNECTIONS_PER_USER` for this user, or `REALTIME_MAX_CONNECTIONS_PER_IP` for anonymous sockets from this address, on this replica. Back off; do not retry immediately |
| `404` | the path is not the realtime path |

A `401` here is answered as a plain HTTP response, before any WebSocket exists,
so a client can tell "refused" from "connected then closed" without guessing.

**A connection does not change identity.** The gate decides at the upgrade, so
a client that signs in while holding an anonymous socket reconnects with its
token to get `user:` channels. Anything else would mean authenticating past the
gate, which is what ADR-0030 refused.

## Frames

Every frame is JSON, `{"type": …}`. The client's are parsed with zod and a
frame that does not parse is answered, never thrown on — a socket is an
unvalidated input for its whole lifetime rather than for one request.

**Client -> server**

| Frame | Effect |
|---|---|
| `{type:"subscribe", channel, proof?}` | answered `subscribed` or `error`. `proof` is required by, and only by, a channel no identity covers — today `otp:` |
| `{type:"unsubscribe", channel}` | answered `unsubscribed`. Always succeeds |
| `{type:"resume", channels[]}` | re-subscribe a set in one round trip after a reconnect; answered `resumed` with what was restored and what was refused. Max 64 |
| `{type:"ping"}` | answered `pong`, for a client that cannot observe WebSocket-level pongs |

**Server -> client**

| Frame | When |
|---|---|
| `{type:"welcome", connectionId, userId, heartbeatMs, maxSubscriptions}` | once, immediately after the upgrade. `userId` is **`null` on an anonymous connection** — present-and-null, because a missing key reads as an older server. The limits are announced rather than documented-only, so a client need not be redeployed to learn them |
| `{type:"subscribed"\|"unsubscribed", channel}` | the answer to the matching request |
| `{type:"resumed", channels[], refused[]}` | the answer to `resume` |
| `{type:"pong"}` | the answer to `ping` |
| `{type:"error", code, channel?}` | a refusal |
| `{type:"message", channel, payload}` | an event on a subscribed channel, fanned out from the process that computed it ([contract.fanout.md](contract.fanout.md)) |

`code` is a machine key the page maps to its own text — deliberately **not**
translated, unlike the `msg` of an HTTP envelope (`forward-auth/contract.md`).
A frame is read by code, and putting `locale-service` in the path of a socket
error would make a refusal depend on a service the socket does not otherwise
need.

| `code` | Meaning |
|---|---|
| `realtime.channelUnknown` | the name matches no channel family |
| `realtime.channelForbidden` | a well-formed name this connection cannot show a claim to: someone else's, or one whose proof is missing, wrong or expired |
| `realtime.subscriptionLimit` | this connection is at `maxSubscriptions` |
| `realtime.badFrame` | not JSON, over `REALTIME_MAX_FRAME_BYTES`, or not a frame this version defines |

## Channels

Who may subscribe to what, and why each family is shaped the way it is, is in
[contract.channels.md](contract.channels.md). Three families exist —
`user:<userId>`, `tenant:<tenantId>` and `otp:<channelId>` — and anything else
is `realtime.channelUnknown`.

## Close codes

4000+ is the application range. Each means something a client acts on
differently.

| Code | Meaning | What a client should do |
|---|---|---|
| `4401` | the session behind this connection is no longer live | sign in again. Do not reconnect with the same token |
| `4408` | the heartbeat went unanswered | reconnect |
| `4429` | too many sockets for this user | back off |
| `4503` | the server is shutting down | reconnect after a backoff |

## Staying connected

- **Heartbeat.** The server pings every `REALTIME_HEARTBEAT_MS` (30s) and
  closes a connection that missed the previous ping. This is not politeness: a
  peer that vanished — a closed laptop, a phone changing network — leaves a TCP
  connection open on this side indefinitely, holding a socket, its
  subscriptions and its slot in the per-user cap, and nothing else ever
  notices. The interval is under Traefik's 60s idle timeout on purpose; a
  keepalive slower than the intermediary it keeps alive achieves nothing.

- **Reconnect with resume.** The client reconnects and declares the channels it
  believes it had; each is authorized again from scratch. **A proof-bearing
  channel cannot be resumed** — the frame carries no proofs, and somewhere to
  keep them server-side is exactly the resume state this design does not have.
  Such a channel comes back in `refused` and the client re-subscribes to it
  explicitly, which it can: it is holding the proof already. The gateway keeps
  **nothing** across a dropped socket, and that is deliberate — a resume token
  redeemed against server-side state only works when the reconnect lands on the
  replica holding it — the same class of failure the fan-out closes: it works
  in dev with one replica and silently stops the day there are two.
  Re-authorizing is the
  load-bearing half, because a reconnect presents a new token and the identity
  behind it may have changed.

- **Missed messages are not replayed.** An event published while nobody is
  connected is dropped, and so is one published in the moment between a
  `subscribed` answer and the subscription landing in Redis. Where a durable
  answer exists it is the producer's, not the socket's — OTP delivery keeps
  its Redis status for exactly this (F-067-a, D-15).

## The session outlives the token, so the session is re-checked

An access token is minted for ~15 minutes; a socket is held for hours. The
gateway re-reads `session:<sessionId>` every `REALTIME_SESSION_RECHECK_MS`
(60s) and closes every connection whose marker is gone with `4401` — the same
question `forward-auth` asks per request, with the same rule for the answer: a
missing marker means revoked, never "unknown, allow"
(`redis-keyspace/contract.md`).

It is one `EXISTS` per **distinct session** per tick, not per connection, so
the cost tracks how many people are connected rather than how many tabs they
have open.

**The window is real and bounded**: up to 60s between a revocation and the
socket closing. Closing it entirely needs Redis keyspace notifications or a
revocation event on the broker — stated here rather than assumed away.

A Redis that is unreachable leaves connections **open**, not closed: a store
outage is not evidence that every session was revoked, and treating it as such
would sign every user out at once. The next tick asks again.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| forward-auth | the decision on the upgrade: identity headers with `X-Session-Id`, or `X-Auth-Anonymous` | **neither** -> the upgrade is refused 401. Fail closed on *silence*, not on absent identity: "nobody is signed in" is an answer and "no answer" is not, and without the marker a router that lost its middleware would downgrade every authenticated socket instead of failing (ADR-0031) |
| redis-keyspace | `session:<sessionId>` must be the key `auth-service` writes | a keyspace mismatch reads as "every session revoked" and closes every socket within one re-check |
| redis-keyspace | `otp:channel:<channelId>` must be the key `auth-service` writes | a mismatch reads as "never minted" and refuses every `otp:` subscription, with no error on either side |
| redis-keyspace | pub/sub on `realtime:<channel>`, on a second connection ([contract.fanout.md](contract.fanout.md)) | no events arrive. Sockets stay open and correct; the platform is silent, and the client falls back to whatever the producing domain stored |
| identity | what a live session means, and who revokes one | — |

## Config

`PORT`; `REDIS_URL`, `REDIS_KEY_NAMESPACE`, `REDIS_KEYSPACE_VERSION` (must
equal `auth-service`'s); `REALTIME_PATH` (`/realtime` — must agree with the
Traefik router rule that carries `my-auth`, or the socket is reachable on a
path the gate does not cover); `REALTIME_HEARTBEAT_MS`;
`REALTIME_SESSION_RECHECK_MS`; `REALTIME_MAX_SUBSCRIPTIONS`;
`REALTIME_MAX_CONNECTIONS_PER_USER`; `REALTIME_MAX_CONNECTIONS_PER_IP` (the cap
that applies when there is no user to count against — an address is a blunt
key, so it is a ceiling on abuse rather than a quota);
`REALTIME_MAX_FRAME_BYTES`.

The fan-out added no variable of its own: it rides the Redis already
configured above, on a second connection. Redis makes that connection
mandatory rather than optional — a client that has issued `SUBSCRIBE` accepts
nothing else until it unsubscribes from everything, so sharing one would break
the session re-check the moment the first socket subscribed to anything.

Traefik must forward `X-Session-Id` and `X-Auth-Anonymous`
(`authResponseHeaders`) **and** strip the client-supplied copies
(`strip-fake-headers`). Both, or a header is either missing or forgeable. The
realtime router carries `my-auth-optional`, not `my-auth`; with `my-auth` every
anonymous upgrade is a 401 and the pre-login half of the platform goes dark.

## Guarantees

- A connection hears its own channels and no others — by identity where it has
  one, by proof where it does not. This is the invariant the unit exists to
  hold, and the one its spec covers
  (`gateway-service/src/app/realtime/channel.spec.ts`).
- An anonymous connection reaches nothing an anonymous caller could not
  otherwise reach. It is admitted, not trusted.
- The gateway holds no JWT secret, no database and no tenant credential. It
  reads identity; it never derives it (ADR-0009's rule, applied here).
- It never writes a Redis **key**. Sessions are `identity`'s to issue and
  revoke; the fan-out connection only ever subscribes and hears.
- Every limit is enforced before the work it bounds: the per-user cap before
  the handshake, the frame size before the payload is buffered, the
  subscription cap before the channel is indexed.
- A malformed frame costs the connection an `error` and nothing else. One
  client's bad input never affects another's socket.

## Not built here, on purpose

| Thing | Where it belongs |
|---|---|
| Deciding what is worth sending, and sending it | the producing domain. The seam is `RealtimePublisher`; the first caller is F-067-j |
| Replaying what a disconnected client missed | nowhere, on purpose ([contract.fanout.md](contract.fanout.md)) |
| Deciding when a client should hold a socket at all, and reconnecting it after sign-in | `panel-web` |
| Per-conversation channels for live chat | F-034 |
