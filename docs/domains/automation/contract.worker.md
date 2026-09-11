---
id: automation
layer: domain
status: active
version: 6
updated: 2026-09-10
---

# Contract — automation: the worker half

The §10 split of `contract.md`, which reached its ceiling at 262 lines. This
file is the **worker runtime** — the processes, the tick, the jobs and the
admin surface over them. `contract.md` keeps the operations table, the
`bot_integration` registry and the guarantees, and links here.

The halves are split where the consumers are: nothing that reads
`bot_integration` reads any of this, and nothing here reads `bot_integration`.
They share the unit because they share three tables and one exchange.

## The worker runtime (F-031-a, ADR-0027)

`worker-service` is a deployable that **serves no requests**. There is no port,
no Traefik label and no route: ADR-0027's argument is that an in-process
scheduler runs inside a request-serving replica, so two replicas run every job
twice and a slow job degrades logins. Bolting an HTTP surface onto this process
would give both back.

Three moving parts, one direction of flow:

1. **Registration.** Every `Job` provider is reconciled into a `bot_worker` row
   on boot, keyed by its `key`. `isActive` is deliberately **not** written:
   the switch belongs to whoever last flipped it (invariant #1), so a redeploy
   cannot switch a worker back on. A `bot_worker` row this build does not
   implement is left alone rather than deleted — it may belong to another
   deployable, and its run history is referenced by foreign key.
2. **The tick.** A timer asks which registered workers came due in the interval
   *since the last tick*, and publishes one `automation.tick.<key>` per due
   worker to a durable topic exchange. The interval, not the instant, is what
   is asked about: an occurrence that fell between two ticks is still found, so
   a late timer does not drop work. It is bounded on the other side too — the
   interval is reset on boot, so a process that was down for a week does not
   fire a week of missed occurrences at once.
3. **The run.** A consumer dispatches on `key`, opens the `bot_execution_log`
   row, runs the handler, and closes the row in both paths (invariant #3).
   `status` is three-way on purpose: some items processed *and* some errors is
   `partial`, which is neither a success to ignore nor a failure to retry whole.

**A job must be safe to run twice.** Delivery is at-least-once, so redelivery
after a crash is ordinary. A job that genuinely cannot tolerate it carries its
own guard; the queue provides none, and ADR-0027 accepts that explicitly.

## The per-tenant cap (F-066-p, F-067-e, catalog 20.2 layer 4)

`AUTOMATION_TENANT_CONCURRENCY` caps how many of `AUTOMATION_PREFETCH`'s slots
**one tenant** may hold, and since F-067-e it caps them across every replica
rather than within one. A tick that names no tenant is never gated. A refused
tick goes back on the exchange, behind everything else, and opens no
`bot_execution_log` row.

Why each of those is the answer — and what a Redis that cannot be reached does
— is [contract.tenant-cap.md](contract.tenant-cap.md).

## The jobs (F-031-c)

| key | what it does | needs |
|---|---|---|
| `worker_heartbeat` | nothing, and records that it did — the proof the tick path is alive | — |
| `vault_credential_retention` | destroys superseded credential versions past their rotation grace window (ADR-0026 rule 4) | `AUTH_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |

The retention job is the first job that does real work, and what it settled is
how a job reaches code it cannot import.

**A job calls another service over the internal seam.** The Credential Vault is
`tenant`'s code inside `auth-service`; an Nx application cannot import another
Nx application. So the job asks over
`POST /api/internal/vault/destroy-expired` behind `ServiceOnlyGuard` — the door
F-066-i built — rather than the vault moving into a workspace library, which
would drag its Prisma models, its KEK service and its audit trail across an app
boundary to serve one caller. `worker-service` therefore holds
`SERVICE_AUTH_TOKEN`, and holds no tenant credential of its own: it asks the
process that owns one to act, and never handles the value.

**Both variables are optional in `worker-service` and read per run.** A job
whose seam is unconfigured fails its own run into `bot_execution_log` and every
other job keeps running; requiring them at boot would stop the consumer
draining the queue because one job's dependency is missing.

**A job never succeeds quietly.** An unreachable service, a guard's 404 and an
answer in a shape the job does not recognise are each indistinguishable from
"nothing was due" if the run reports zero items and success. Each one throws,
so the consumer records `failed` (invariant #3). This is the rule a sweep needs
most: it is the kind of job nobody looks at while it is working.

## The admin surface (F-031-b)

Five routes under `/admin/workers`, in `auth-service`. Moved to
[contract.admin.md](contract.admin.md) when this file passed 250 lines (§10):
its audience is an admin panel, and everything else here is the runtime.

## The dead-letter path (F-067-d)

The paragraph above used to end the story, and its argument only ever covered a
*tick*: a tick recurs, so a destroyed one costs an interval. F-067-a (an OTP
send), F-067-b (a bot update) and F-067-c (an outbox event) each put a message
on this broker that does not recur, and each depends on this section existing
first.

**The queue carries `x-dead-letter-exchange`, and that is the whole mechanism.**
Every rejection the broker sees — a failed handler, a body that is not JSON, a
tick the tenant gate gave up on — is moved to `AUTOMATION_DLX` and its queue
instead of being dropped. Rejecting and letting the broker move the message is
atomic; the alternative, publishing our own copy and acking the original, loses
the message for good if that publish is what fails — and it did so silently
until F-067-f, below.

**The queue has a new name, `txnet.automation.ticks.v2`.** A durable queue's
arguments cannot be changed in place — asserting the existing one with a
dead-letter argument fails with PRECONDITION_FAILED, on every boot, on every
deployment that ran the previous build. Renaming makes the change self-healing
and costs at most one tick interval of queued work, all of which recurs. The old
queue drains itself and can be deleted whenever an operator gets to it.

**Three ending paths, told apart from the message itself.** AMQP carries nothing
back through a rejection, so the reason cannot be attached at the moment of
failure. It does not need to be: `deadLetterRecordOf` reads it off the message —
a body that did not parse is `unparseable`, a tick whose `deferrals` reached
`MAX_DEFERRALS` is `gate_gave_up`, and everything else is `handler_failed`. What
the handler actually threw is not duplicated here; that is the
`bot_execution_log` row for the same run.

**The attempt count rides on the message.** Every publish stamps `x-attempts`,
so a tick the gate deferred nineteen times arrives carrying twenty, and the
broker's own `x-death` count is taken when it is higher. Without it the
twentieth attempt is written down as the first, and the pathological case reads
like the ordinary one.

**A queue is not a record, so the queue is drained into a table.** Reading a
dead-letter queue means consuming it, which makes whoever looks last the person
who decides what nobody else sees. `DeadLetterDrain` writes one
`automation.dead_letter` row per message and acks; a write that fails nacks
**with** requeue, because at that moment the queue holds the only copy — a
database that is down must stop the drain, not consume what it cannot record.
That is the opposite of the main queue's rule, and it is the opposite for the
reason the main queue's rule works: there, a message that keeps failing has
somewhere to go.

`GET /admin/workers/dead-letters` is the reading half, in `auth-service` for the
same reason the rest of the admin surface is (ADR-0027). It is read-only:
re-driving a dead message back onto the exchange is a decision about ordering
and idempotency, not a button, and it belongs to a row of its own.

## Publisher confirms (F-067-f)

**Both publishers use a confirm channel and await the answer.** A plain publish
is answered by nothing, so a broker that took the frame and then dropped it — a
full disk, a queue over its limit, a node failing over — reported success. That
was survivable while the only message was a tick, which recurs, and is not
survivable for the OTP send, bot update and outbox event F-067-a, F-067-b and
F-067-c put on this broker.

**Every publish is `mandatory` too**, because a confirm says the broker accepted
the message and nothing about where it went: AMQP acks a publish to an exchange
with no matching binding. That is `auth-service`'s real case — it asserts the
exchange and never the queue.

`confirmedPublisher` tells the three failures apart as `nacked`, `unroutable`
and `timeout`, bounded by `AUTOMATION_PUBLISH_CONFIRM_MS`. It is invariant #10.
In `worker-service` a failed publish is logged and the occurrence is lost, the
cost the deferral path already accepts. In `auth-service` it fails the route:
`POST /admin/workers/:key/run` answers 503, the shape it already used for an
unreachable broker (D-18). Answering 200 and reconciling needs the durable store
F-067-c builds.

## A second queue: OTP delivery (F-067-a)

`worker-service` consumes one more queue than it publishes to.
`AUTOMATION_OTP_QUEUE` is bound to `otp.delivery.#` on the same exchange, with
the same `x-dead-letter-exchange`, and `OtpDeliveryConsumer` drains it by
calling `POST /api/internal/otp/deliver` — the seam `VaultRetentionJob` already
uses, for the same reason (`interfaces/auth-api/contract.md`).

Three things about it are deliberate:

- **Its own queue, the same exchange.** A slow SMS provider must not sit in
  front of a due tick, and the two depths are worth alerting on separately
  (F-067-g). A second *exchange* would buy nothing and cost another thing to
  declare, monitor and dead-letter.
- **Not a `Job`.** It has no schedule, no `bot_worker` row and nothing to
  reconcile; making it one would write a `bot_execution_log` row per OTP.
- **A refusal is not a failure.** `delivered:false` — an unlinked messenger, an
  unconfigured channel — is acked: a redelivery would be refused identically,
  and the user reads the reason off the delivery status. Anything else throws
  and dead-letters, per the rule above.

## The outbox (F-067-c)

The relay ADR-0021 decided is a third `Job` in this process (D-14), and it is
[contract.outbox.md](contract.outbox.md) — a §10 split, because its audience
is a producing domain rather than anyone reading the tick runtime.

## What is watched

Eight Prometheus alert rules watch this queue and the outbox, and what each
one means is
[contract.monitoring.md](contract.monitoring.md) — split out under §10 because
the audience is different: nothing that calls this runtime reads an alert
threshold, and nobody holding a pager reads the tick topology.
