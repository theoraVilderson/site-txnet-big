---
id: automation
layer: domain
status: active
version: 6
updated: 2026-09-10
---

# Contract — automation: the transactional outbox

A §10 split of [contract.worker.md](contract.worker.md), which is at its
250-line ceiling. That file is the tick runtime — schedules, jobs, the
dead-letter path. This one is the outbox ADR-0021 decided and F-067-c built,
and it is split off rather than appended because its audience is different:
this is the file a **producing domain** reads when it needs to announce
something, and nothing in it is about ticks.

## What it is for

ADR-0021's failure is specific. A confirmed payment must provision a config
(`billing` -> `network`), credit a commission (`billing` -> `tenant`), deliver
a campaign (`notification`). Call the panel synchronously inside the money
transaction and either the transaction rolls back after the money moved, or
the money moves and no service appears. Publish after the commit instead and
there is a window in which the event is owed and no record says so.

So: **the producing service inserts an `automation.outbox_event` row inside
the same Postgres transaction that writes the ledger**, and `OutboxRelayJob`
publishes the unpublished rows afterwards. The event and the state change that
caused it commit or fail together, which is the whole of ADR-0021.

**Nothing produces yet.** `billing`, `network`, `notification` and `ai` are all
`draft`, so the table has no writer and the relay drains an empty table. That
is why this was cheap to build today and would not have been on the day the
first payment landed.

## How a domain writes one

Inside the transaction, never outside it. There is no service API for this and
there deliberately is not: an API call is a second thing that can fail, and a
second thing that can fail is what the outbox exists to remove.

| column | what goes in it |
|---|---|
| `aggregate` | what it is about — `billing.payment`, `network.config` |
| `aggregateId` | which one |
| `type` | what happened — `payment.confirmed`. **It is the routing key**, see below |
| `payload` | the domain's own shape. Nothing outside the domain types it |
| `occurredAt` | defaulted. When the transaction said it happened, not when it was sent |

The relay owns `publishedAt`, `attempts` and `lastError`. A producer never
writes them and never reads them: whether an event has gone out is not a fact
a producer can act on, because by the time it could ask, the answer has
changed.

## The wire

The routing key is `outbox.<type>` on the exchange the rest of automation
already uses (`AUTOMATION_EXCHANGE`), and `outboxRoutingKey`
(`shared-core/src/lib/automation/outbox.ts`) is the only thing that builds it.
The `outbox.` prefix is not decoration: `automation.tick.#`, `otp.delivery.#`
and `bot.update.<slot>` are already bound on that exchange, and `type` is a
string a domain chooses — one day a domain chooses `bot.update` and its events
start arriving at a bot consumer.

`type` is validated rather than trusted, because it arrives from a database
column and AMQP does not refuse a bad routing key. It matches nothing, for
ever, silently. A `type` that is not a dot-separated path fails the row with
that reason in `lastError` instead.

**Delivery is at-least-once and never exactly-once**, which ADR-0021 says
plainly and this implementation cannot improve on: the relay can publish a row
and lose the process before it stamps `publishedAt`. The row's `id` is the
event id and travels as the AMQP `messageId`, so a consumer dedupes on it
before it parses anything. **A consumer that cannot safely process the same
event twice is a bug in the consumer.**

That is the whole of the consumer-side contract that exists today, and it is
less than ADR-0021 asks for: there is no shared `processed_event` store and no
helper, because there is no consumer to use one. Writing that table now would
mean choosing its shape — per-consumer or shared, in which schema, with what
retention — for callers that do not exist, and the first real consumer is what
should answer it.

## The relay

`outbox_relay` is a third `Job` in `worker-service`, beside `worker_heartbeat`
and `vault_credential_retention` (D-14). No new unit and no new deployable:
one table and one job, next to the runtime that already owns the exchange.
ADR-0021 calls the outbox a new unit; splitting it out later stays cheap while
it is still one of each.

**It needs an `always_on` `bot_schedule`**, exactly like the other two — a job
with no schedule never becomes due. Its latency is therefore one
`AUTOMATION_TICK_INTERVAL_MS`, 60 seconds by default, and the day an event
cannot wait a minute that is a schedule change rather than a rewrite.

**Rows are claimed `FOR UPDATE SKIP LOCKED`, `AUTOMATION_OUTBOX_BATCH` at a
time.** Two relays running at once is the expected case, not the pathological
one: ADR-0027 makes redelivery ordinary and a deployment may have several
replicas. `SKIP LOCKED` makes that harmless — each transaction takes a
disjoint batch and neither waits. Without it the second relay blocks on the
first's rows and republishes every one of them the moment it unblocks.

**`publishedAt` is stamped inside the same transaction as the publish, after a
confirmed one** (invariant #10). The two directions are not symmetric, and the
order is chosen for that: a publish that succeeded against a stamp that rolled
back sends the event twice, which the idempotency key covers. A stamp that
committed against a publish that never happened loses the event with the table
asserting it was sent — the exact window the outbox exists to close.

**A failed publish stops the batch and fails the run.** Whatever refused the
row is about the broker, not the row, so working through the rest of the batch
against it buys nothing; the remaining rows keep their place in `occurredAt`
order. The run throws, so `TickConsumer` records `failed` (invariant #3) — a
`success` with a count of zero is indistinguishable from an empty outbox, and
an empty outbox is what a healthy one looks like.

**`lastError` is written after the transaction it describes has rolled back**,
which is the one ordering detail in the relay that is invisible if it is
wrong: written inside, the only record of why the relay is stuck is discarded
along with the failure. It carries the publisher's reason — `nacked`,
`unroutable` or `timeout` — because the message alone does not say which.

**The relay never gives up on a row.** There is no attempt ceiling and no
dead-letter path for the outbox, and that is deliberate: a row that has not
published is not lost, it is in a durable table that is itself the audit trail
of what the system decided to announce. Nothing is gained by moving it
somewhere else, and an event a committed transaction promised is not something
to throw away because nobody was listening yet. What makes the retrying
visible instead is monitoring — see [contract.monitoring.md](contract.monitoring.md).

**Today every publish that happens at all is `unroutable`**, because no domain
binds a queue to `outbox.#` and every publish is `mandatory`. That is the
correct answer rather than a gap: an event announced to nobody is not an event
delivered, and the alternative — a plain publish the broker acks into nothing
— is what invariant #10 exists to forbid.

## What is not built

- No consumer, no consumer-side idempotency store (above).
- No retention or archive of published rows. ADR-0021 makes the table an audit
  trail; when that stops being worth keeping needs a producer with an opinion.
- No admin surface. `GET /admin/workers/dead-letters` has no outbox twin —
  the alerts in `contract.monitoring.md` are how a person learns something is
  wrong, and the row itself is a `SELECT` away.
