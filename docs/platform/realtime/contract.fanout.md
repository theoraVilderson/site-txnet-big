---
id: realtime
layer: platform
status: active
version: 1
updated: 2026-09-10
---

# Contract — realtime fan-out

How an event computed in another process reaches the replica holding the
user's socket (F-067-i). A §10 split from `contract.md`, which was at 205
lines; the frames, the channel families and the connection's own lifecycle
stay there.

## The failure this closes

`ConnectionRegistry` is per process. The process that finishes a job —
`worker-service` — is a different process, usually on a different machine,
from the one holding the user's socket. Before this, `deliver` reached only
the sockets that happened to be on the same replica.

With one replica that is every socket and everything works. With two it is
roughly half of them, and **nothing reports it**: the publish succeeds, the
gateway is healthy, the socket is open, and the event simply never arrives.
That is why the gateway must not be scaled past one replica without this, and
why the row gated production rather than improving it.

## The transport is Redis pub/sub, not the broker

Every other message on this platform rides RabbitMQ. This one deliberately
does not, and the reason is that the two want opposite properties.

| | broker messages | a realtime event |
|---|---|---|
| Delivery | at-least-once, acked | at-most-once |
| Nobody listening | it waits in a durable queue | it is dropped |
| Handler failed | dead-lettered and recorded (F-067-d) | there is nothing to record |

Putting realtime events on RabbitMQ would mean a durable queue declared and
torn down per replica as replicas come and go, and a dead-letter queue slowly
filling with events for people who closed a laptop. Redis pub/sub has the
semantics this needs, and both processes already hold a client on the same
Redis, so it costs one connection rather than a topology.

**The durable answer, where a feature needs one, stays the producer's.** OTP
delivery keeps its Redis status for exactly this (F-067-a, D-15) and a client
that reconnects reads it. The socket is the fast path, never the record.

## The wire

| | |
|---|---|
| Channel | `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:realtime:<channel>` |
| Body | `{"payload": <anything>}`, JSON |
| Delivered as | `{type:"message", channel, payload}` on every subscribed socket |

`<channel>` is a realtime channel name — `user:<userId>`, `tenant:<tenantId>`
or `otp:<channelId>` (`contract.channels.md`). Built by
`RedisKeys.realtimeFanout` on both sides from one shared constant
(`shared-core/src/lib/realtime/fanout.ts`), which also builds the `otp:` name
itself (`otpRealtimeChannel`) because three processes have to agree on it.

**The keyspace prefix is applied by hand, on both ends.** ioredis prepends it
to *key* arguments, and `PUBLISH` / `SUBSCRIBE` take a channel, which Redis
does not count as a key — so the prefix every other call gets for free is
silently absent here. A publisher that forgets it publishes successfully into
a channel nobody is listening on, and neither side raises anything. This is
the single most likely way this mechanism breaks, which is what
`gateway-service/src/app/realtime/fanout.spec.ts` pins.

A body that is not an envelope is dropped with a log line, never thrown on: a
pub/sub listener has no caller to catch an exception, and one raised there
would take every socket on the replica with it.

## Fan-out is per channel, not per replica

A gateway replica subscribes to exactly the channels its own connections hold,
so Redis routes each event to the replicas that can use it and to no others.
`RealtimeFanout.reconcile` keeps that set in step with `ConnectionRegistry`
after every subscribe, unsubscribe and dropped connection.

Two properties are load-bearing:

- **It reconciles against the registry, not against the event that woke it.**
  A subscribe and an unsubscribe on one channel can race — two tabs, one
  closing as the other opens — and a pair of "do the opposite of what just
  happened" commands settles on whichever round trip finished last. Reading
  the desired state at the moment the command is issued cannot be wrong that
  way. Calls are chained per channel so two concurrent reconciles cannot both
  read "not subscribed" and both subscribe.
- **Every path that drops a connection reconciles.** A closed socket, a missed
  heartbeat, a revoked session. A channel name is client-chosen, so a
  subscription that outlives its last connection is a client-controlled leak.

The alternative — one broadcast channel every replica filters — works, and
costs N times the traffic to deliver the same message. That only hurts at the
scale this row exists for.

## What it does not decide

**Who may hear a channel.** That is settled once, at subscribe time, by
`channel.ts`. A producer naming a channel is naming an address; the fan-out
routes by name and never inspects an identity. A second opinion here would be
a second place for the rule to be wrong, and the rule is the one thing the
unit exists to hold.

**Whether the event arrived.** `PUBLISH` answers how many subscribers Redis
handed it to. That says nothing about whether a socket wrote it, and **zero is
the ordinary answer** for a user who is not connected. A caller must never
treat a publish as the record that something happened.

**Whether the work succeeded.** A failed publish is logged and swallowed on
the producing side. The caller is finishing real work — an OTP sent, a payment
confirmed — and a Redis that is unreachable must not turn that into a failure
of the work itself.

## The gap between `subscribed` and subscribed

The client is answered `subscribed` without waiting for the Redis round trip.
An event published in that window is missed, which the contract already
allows. Holding the answer back would buy nothing and would cost a `subscribe`
frame that blocks on Redis.

## Producers

| Unit | Publishes | Via |
|---|---|---|
| identity | the end state of one OTP send, on `otp:<channelId>` (F-067-j) | `OtpDeliveryStore.mark` (`auth-service`) |
| automation | anything a job or queue consumer finished that a user is waiting for | `RealtimePublisher` (`worker-service/src/app/realtime/`) |

**The first producer publishes from `auth-service`, not from the worker**, and
that is worth explaining because the seam was built expecting the opposite.
The OTP result is recorded and pushed by the same method, because a caller able
to do one without the other can leave a client waiting on a socket for an event
about a status that already changed. The status write lives in `auth-service` —
it is `identity`'s state — so the publish does too. It also means console
delivery mode, which never reaches a queue at all, still pushes; a dev box
where the socket silently does nothing is a dev box where nobody notices it is
broken.

`worker-service`'s `RealtimePublisher` therefore still has no caller. It is the
right seam for work that genuinely *finishes* in the worker — F-034's live chat
is the shape it was built for — and it stays for the reason F-067-h built the
channel index ahead of its first producer: it is the half that cannot be
retrofitted without a second replica having already lost messages nobody
noticed.
