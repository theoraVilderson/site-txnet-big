---
id: panel-web
layer: interface
status: active
version: 12
updated: 2026-09-10
---

# Contract — the panel's WebSocket client

`site-pwa/src/lib/realtime.ts` is the only place this app opens a socket. It is
the transport and nothing else: it knows no screen, no payload shape and no
route. The frames it speaks belong to `platform/realtime`
([contract.md](../../platform/realtime/contract.md),
[contract.channels.md](../../platform/realtime/contract.channels.md)) and are
not restated here — this file is the browser's half, which that unit
deliberately does not own ("Deciding when a client should hold a socket at all,
and reconnecting it after sign-in → `panel-web`").

## Why a transport of its own

Two screens want live updates and they want it on different terms: the OTP
screen holds an anonymous socket for the length of one delivery, and the signed-in
panel holds one for the length of a session. Neither of them should be the
place reconnect backoff or resume is written, because the second one to be
built would write it again, slightly differently, and the difference would only
show up on a bad network.

## The shape

```ts
const client = createRealtimeClient({ credential: () => authApi.accessToken() });
client.connect();
const stop = client.subscribe("otp:abc", { proof, onMessage, onError });
stop();          // leaves the channel; the socket stays
client.close();  // for good — no reconnect follows, on any code
```

- **`credential` is read on every connect**, not captured once. The access
  token rotates on refresh (F-0209), and a reconnect that offered the token
  from twenty minutes ago would be refused for a reason the page could not see.
- **Several listeners may share one channel.** The server subscription ends
  when the last of them leaves, so two components on one page do not fight over
  it. The cap counts channels, not listeners.
- **`onError` receives a machine key**, never a sentence —
  `realtime.channelForbidden` and its three siblings. A socket refusal does not
  pass through `locale-service`, so the screen maps the key to its own string.

## The five rules that are not obvious

**1. The subscription cap is counted here.** `welcome` announces
`maxSubscriptions` and the client refuses the channel over it locally, calling
`onError("realtime.subscriptionLimit")` and handing back a no-op handle.
Learning the cap by being refused means the refusal arrives after the screen
has already rendered, with nothing to render instead.

**2. A proof-bearing channel is re-subscribed, never resumed.** After a
reconnect the client declares its identity-scoped channels in one `resume`
frame and sends an explicit `subscribe` for every channel holding a proof,
because `resume` carries no proofs and the gateway keeps nothing across a
dropped socket. A channel refused on resume with a proof still in hand is
re-proved; one with no proof is dropped and its listeners told
`realtime.channelForbidden`. This is the failure that would be silent: the OTP
result simply stops arriving, on a screen showing no error.

**3. `4401` is a sign-out, not a reconnect.** The gateway re-reads the session
marker every 60s and closes with `4401` when it is gone. The client stops for
good and calls `onSessionLost`, which is the page's own no-session redirect.
Reconnecting instead asks the same question forever and turns one revocation
into a loop.

**4. The page keeps its own heartbeat.** The server's is a WebSocket ping, and
a browser answers it without telling the page — so a peer that vanished leaves
this side holding a socket that will never carry anything again. The client
sends a `ping` frame every `heartbeatMs` and drops a socket that has heard
nothing for two of them. Any inbound frame counts as life, not just `pong`.

**5. A browser cannot see the `401`.** The gate answers a bad credential with a
plain HTTP `401` before any socket exists, and the browser reports that as a
close with no status — identical to a network drop. So a socket that closes
*before* it was welcomed while a credential was offered calls
`onCredentialRejected` once, which is where the page refreshes its access
token, and then retries with backoff. Reconnects are exponential to 30s with
±20% jitter, and a `4429` starts high because the user already holds every
socket they may.

## The first consumer: what became of the code (F-070-b)

The four routes that queue an OTP — `/auth/register`, `/auth/login/otp/request`,
`/auth/password/forgot` and `/auth/login/password`'s `requiresOtp` branch —
answer with `deliveryId`, `channel` and `channelToken` (`auth-api` v14).
`_hooks/useOtpDelivery.ts` turns those three into one state the OTP screen
renders, and it is the only thing in this app that subscribes an `otp:` channel.

The socket it opens carries **no credential**: those routes have no session by
definition, so the channel is authorized by the token the 202 handed over and
not by who is asking (ADR-0031). It is opened when the step is entered and
closed when the step is left, which is also its whole lifetime — the channel
dies with `RedisTtl.otpChannel` (300s) either way.

**The push is not the record.** `POST /auth/otp/delivery/status` is (D-15), and
the hook reads it once beside subscribing, because a realtime event is
at-most-once and is dropped when nobody is listening
(`realtime/contract.fanout.md`). The two answer the same question and either
may be first, so **only an end state ever replaces what is held**: a `queued`
arriving after a pushed `sent` is the older of two answers, and applying it
would send a screen that had finished back to waiting.

**`queued` renders as *not yet*, never as *no such number*.** The handles are
minted before the route knows whether there is an account behind the phone
number — that is what stops a 202 from being an account-existence oracle — so a
delivery that never moves is indistinguishable from a slow provider and is
shown as one. The same reasoning governs a refused subscription: an expired
channel and one nobody ever minted are the same refusal
(`realtime/contract.channels.md`), so `onError` shows nothing at all and the
screen stays on `queued`.

**`failureKey` is a machine key and this app owns the sentence.** It arrives
over a socket, which does not pass through `locale-service`, so `OtpStep` maps
the key to a string of its own under `auth.otpDelivery.*` — the same rule as a
socket refusal code, and the reason `contract.errors.md`'s "no message
`auth-api` owns is copied here" is not violated: nothing is copied, the panel
writes its own line. A key with no row falls back to the general failure line,
because an unmapped key is still a failed send.

The `linkRequired` branch carries no handles and starts nothing: no code was
queued, and the bot sends it once the user shares their contact there.

## The second consumer: one socket for the signed-in session (F-070-c)

`app/(panel)/_context/PanelRealtimeContext.tsx` holds it, and
`usePanelRealtime()` hands it to any screen under the panel layout. It is at
the **layout** and not in a page, which is the whole reason it survives
navigation: everything under `(panel)` is one mount, so moving between screens
costs no reconnect.

Its credential is the access token, because the upgrade is authenticated by
`forward-auth` like every other request. That token is also the page's, and it
rotates (F-0209) — so the two can disagree, and that seam, not the frames, is
what this consumer is about.

**It opens only once there is an account.** `PanelSessionContext` trades the
refresh cookie for a token once per page load; a socket opened before that
lands is an *anonymous* connection, and an anonymous connection is refused
every `user:` channel by construction
([realtime/contract.channels.md](../../platform/realtime/contract.channels.md)).
It would connect, be welcomed, and carry nothing — with no error anywhere. So
the provider waits for the session and keys the socket to the account it
resolved to.

**A refused upgrade refreshes the token, once.** `onCredentialRejected` calls
`authApi.refresh()` and not `ensureSession()`, which is memoised per page load
and would hand back the same dead token; the client has already stopped and
retries on its own backoff, so a live token is the only thing this owes it. A
refresh that fails means the cookie is gone too, and that ends the session
here rather than asking again forever.

**`4401` is the panel's own no-session redirect.** The gateway re-reads
`session:<id>` on its interval and closes with `4401` when the marker is gone,
which is a sign-out that happened somewhere else — another tab, another device,
an admin. The client stops for good on that code and this provider routes it to
the login screen, the same answer `PanelSessionContext` gives a missing cookie.

**A switch is a close-and-reopen.** The socket is keyed to the current
account's `userId`, so a change of identity tears the connection down and
builds a new one. `AccountSwitcher` already throws the whole document away
(`window.location.assign`), which achieves the same thing — but that is its
choice, and this keying is what makes it a rule of the socket instead.

**There is no producer for a signed-in channel yet.** `F-067-i`'s fan-out has
one caller and it publishes to an anonymous `otp:` channel; `F-034` live chat
is the first thing that will subscribe a `user:` channel. So what this
consumer currently proves is a connection that survives navigation and a
switch, not anything a user can see.

## Identity does not change on a live socket

The gate decides at the upgrade (ADR-0030), so a client that signs in while
holding an anonymous socket must `close()` and open a new one to get `user:`
channels. There is no frame that promotes a connection, and adding one would be
authenticating past the gate.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| realtime | the socket at `wss://api.<domain><REALTIME_PATH>`, its frames, its refusal codes and its close codes | no live updates, and no screen breaks: every consumer keeps the durable answer its producing domain stored (D-15), so the socket is how a page hears sooner, never the only way it hears |

This row belongs here rather than in [contract.md](contract.md), which is at
§10's hard 250-line ceiling — the language section is the split that would buy
it room back, and that is a row of its own.

## Config

`NEXT_PUBLIC_REALTIME_PATH` (from the one `REALTIME_PATH` in `.env`, the same
value `gateway-service` and the Traefik router rule read) and, optionally,
`NEXT_PUBLIC_REALTIME_ORIGIN` for a deployment that does not serve the socket
from `NEXT_PUBLIC_API_ORIGIN`. `src/env.ts` builds `REALTIME_URL` from the two,
turning `https` into `wss`. Both names carry `NEXT_PUBLIC_` because only those
reach the browser bundle and the socket is opened nowhere else (F-068's lesson,
in the other direction).

An unset origin yields an empty URL and `connect()` does nothing — a deployment
with no gateway is quiet, not broken.
