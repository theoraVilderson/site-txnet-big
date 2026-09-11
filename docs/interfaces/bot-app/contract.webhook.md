---
id: bot-app
layer: interface
status: active
version: 11
updated: 2026-09-10
---

# bot-app — the front door

A §10 topic split of [contract.md](contract.md): everything between a platform
POSTing an update and a flow being asked to answer it. It is one section
because F-067-b made it one mechanism with two ends, and because the rules it
holds are the only ones in this unit that a stranger on the internet can test.

## `POST /api/bots/:platform/:webhookPath`

One unguessable path per bot, and the path is what resolves the tenant (F-320,
ADR-0023). **The tenant is never read from the body** — a body is written by
whoever sent the update, so a tenancy decision taken from it is a tenancy
decision taken by a stranger.

| file | holds |
|---|---|
| `webhook/webhook.controller.ts` | the route: resolve the path, verify the secret, publish, 200 |
| `webhook/update.normalizer.ts` | the last place that knows what a Telegram `Update` looks like |
| `webhook/bot-update.publisher.ts` | the broker connection, and what rides it |
| `webhook/bot-dispatch.controller.ts` | the way back in: `worker-service` asking for one update to be run |
| `common/service-only.guard.ts` | the service token on that way back in |

Three rules the route exists to hold:

1. **Every refusal is a bare 404** — an unknown path, an unknown platform, a
   wrong secret token, an integration whose token is gone. A URL that answers
   differently for a wrong secret is a URL that can be probed.
2. **The secret header is verified on every request that sends one**, and is
   required on Telegram (F-321). Bale does not send the field, so there the
   32-byte path is the whole credential.
3. **Once the path and the secret are good, the answer is 200 as soon as the
   update is on the broker — and only then.**

Rule 3 is the one F-067-b changed, and it inverted. It used to read "always
200, whatever the handling did", because handling ran inline and a redelivery
replayed a flow that had already half-run. Now the route does one thing, so a
publish the broker did not confirm escapes as a **5xx** and the platform
redelivers (D-18, invariant #10). A redelivery is this path's only recovery
until F-067-c gives it a durable store.

## The webhook does not converse (F-067-b)

Until 2026-09-10 the route ran `BotDispatcher`, the `auth-api` call inside it
and the `sendMessage` back to the platform before returning. Telegram allows a
webhook a few seconds and redelivers what it did not hear back about, so one
slow tenant occupied the shared `bot-service` and earned duplicate updates for
every tenant on it.

The route now normalises the update and publishes it. What is published is a
`ChatContext` **with the integration taken off and the webhook path put on**,
and that swap is the security content of the change: a `BotIntegration`
carries `tenantId` and `credentialRef`, so putting one on a queue would make a
tenancy decision travel as data, to be trusted on the way out by whoever reads
it. The path is a lookup key, so the far end resolves the tenant exactly as the
front door did.

## Order in a chat is a property of the topology (D-16)

Running the flow inline gave ordering away for free — one awaited handler, one
update at a time. A queue with N consumers does not.

So: **a routing key per chat over a fixed queue set.** `bot.update.<slot>`,
where the slot is a hash of the chat id (`shared-core`
`automation/bot-update.ts`), and each queue has exactly one consumer holding
one unacked message at a time. One chat therefore only ever reaches one queue,
and parallelism is the number of queues — a number an operator sets, not a
rewrite. A shared queue with a Redis lock per chat was rejected: a locked-out
update goes back on the queue, which is the ordering problem again with more
moving parts.

Two settings, in two services, **must agree**: `BOT_UPDATE_QUEUES` here
computes the routing key, and `BOT_UPDATE_QUEUES` in `worker-service` declares
the queues bound to it. A publisher that thinks there are more addresses a
queue nobody declared — loud, because the publish is `mandatory` and the route
then answers 5xx. A publisher that thinks there are fewer leaves an idle
consumer, which is silent. Raise the pair while the queues are drained: a
change re-shards, and updates in flight for one chat may sit on its old queue
while new ones go to the new one.

## `POST /api/internal/bots/dispatch` — the way back in

Service callers only (`SERVICE_AUTH_TOKEN`, ADR-0011), refusing with a 404 for
the reason the webhook path does. It is **not published through Traefik**: the
router for this service matches `PathPrefix(/api/bot)`, which this path is not,
so it exists only on the private network.

The flow comes back into this process rather than moving into the worker
because the conversation *is* this unit — the dispatcher, five flows, the Redis
nav store, the chat's session, the `auth-api` client. `worker-service` has now
answered that question the same way three times (F-031-c, F-067-a, this): reach
the owning service over the internal seam, do not move its code across an Nx
application boundary. What the feature removes is the flow from the **webhook
request**, which was the failure.

| answer | means | the consumer |
|---|---|---|
| `200 {dispatched: true}` | the flow ran | acks |
| `200 {dispatched: false}` | the webhook path no longer resolves — the bot was deleted or disabled after the update was queued | acks; no user is waiting and a redelivery resolves to nothing again |
| `400` | a body this service published and cannot read back | dead-letters (F-067-d); it is a bug in the pair, not a retryable failure |
| `404` | an unrecognised caller — normally a rotated `SERVICE_AUTH_TOKEN` | dead-letters |
| `5xx`, a timeout, no answer | the flow failed or this process is down | dead-letters |

Nothing is destroyed on any of those paths: the queues carry
`x-dead-letter-exchange`, so a rejection is moved and recorded in
`automation.dead_letter` (invariant #9). That is why F-067-d had to be built
before this row — an update, unlike a tick, does not recur.

## What an operator watches

Queue depth per bot-update queue and the dead-letter count, both already in
`automation.rules.yml` (F-067-g). A depth that climbs on **one** queue and not
the others is one chat or one tenant flooding a slot, which is the failure the
fixed set makes visible instead of hiding in a thread pool.
