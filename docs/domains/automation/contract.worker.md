---
id: automation
layer: domain
status: active
version: 7
updated: 2026-09-17
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
| `vault_credential_retention` | destroys superseded credential versions past their rotation grace window (ADR-0026 rule 4) | `TENANT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `deposit_pending_expiry` / `invoice_pending_expiry` | expires `pending` top-ups / unpaid invoices past their `expiresAt` and gives their coupon holds back (F-092-k `contract.deposit.md`; F-111-a `contract.purchase.md`, billing) | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `deposit_reconciliation` | asks the gateway about pending and expired top-ups nobody came back for, and about a verifying one only when its retry is 10 min overdue (the next job is not running): credits what it confirms, flags a differing amount (F-092-l; `domains/billing/contract.verify.md`) | the same two |
| `deposit_verify_retry` | asks again about verifying top-ups whose retry is due, every tick: credits, re-schedules silence, flags one still verifying after a day (F-092-y, F-092-ac) | the same two |
| `notification_campaign_fan_out` | writes recipient rows for started campaigns in resumable batches (F-035-d, `domains/notification/contract.md` "Sending") | `NOTIFICATION_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `notification_campaign_delivery` | sends claimed queued recipients through their tenant's Telegram/Bale bot; `stalled` rows are its errors (F-035-e, same contract, "Delivering") | the same two |
| `tenant_subscription_renewal` | renews due reseller subscriptions from their billing wallet, warns or suspends the unpaid; a platform tick, seeded `*/5`; `failed` renewals are its errors (F-019-c, `domains/tenant/contract.billing.md`) | `TENANT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` (F-018-v) |
| `grant_config_purge` | releases the panel seats of suspended Grants past their `purgeAfterDays` — `desiredRemote = absent`, our rows never deleted (F-027-y, `domains/entitlement/contract.md`); a platform tick, seeded `20 * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `grant_group_fulfilment` | places a config on every non-drain healthy member of a Grant's panel group and activates it at `minHealthyPanels` — asks `fulfil-due` (F-027-bl, `domains/network/contract.groups.md` rule 11), then `drain-due`: retires a drained member's configs after 2 × TTL and removes it (F-027-bm, rules 13-15); a platform tick, seeded `* * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `grant_delivery` | checks paid `pending` Grants whose `nextDeliveryAt` is due — delivered, retried at 1, 2, 4, 8, 16, 32 min, or cancelled and refunded in full — asks `deliver-due` (F-111-d, `domains/entitlement/contract.md`); a platform tick, seeded `* * * * *` | `BILLING_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |
| `network_traffic_rollup` | rolls raw traffic into `traffic_daily_aggregate` and drops a raw month only once its aggregate matches it (F-027-o, `domains/network/contract.rollup.md`); a platform tick, seeded `15 3 * * *`; a refused drop fails the run | — (it calls `network.*` functions through its own pool) |
| `tenant_domain_verification` | proves `verifying` custom domains and re-validates `verified` ones' TXT records; a platform tick, seeded `*/5`; a domain whose check threw is an error (F-018-i, `domains/tenant/contract.domains.md`) | `TENANT_API_BASE_URL` + `SERVICE_AUTH_TOKEN` |

The retention job is the first job that does real work, and what it settled is
how a job reaches code it cannot import.

**A job calls another service over the internal seam.** The Credential Vault is
`tenant`'s code, its seams in `tenant-service` (F-018-ab); an Nx application cannot import another
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

**Two jobs over one seam are still two jobs.** Expiry reads a clock and calls
no gateway; reconciliation makes one call to a bank per payment. They are
separate keys with separate schedules and separate timeouts, because merging
them would tie the cheap frequent one to the rate a bank will answer.

**A job is registered; it is not scheduled.** `WorkerRegistryService` upserts a
`bot_worker` row on boot, and the publisher ticks a job only for the
`bot_schedule` rows an operator set through `/auth/workers` (F-031-b). A new
job therefore runs never until somebody schedules it — which is a deliberate
default for a sweep that writes, and the first thing to check when one appears
to do nothing. **Three exceptions are seeded** by `prisma/seed.js`
(`SEEDED_SCHEDULES`): `fx_rate_refresh`, and — decided by the user 2026-09-14
— `deposit_pending_expiry` (`always_on`) and `deposit_reconciliation` (`*/5`); since
F-092-ac also `deposit_verify_retry` (`always_on`), since F-035-d `notification_campaign_fan_out` and F-035-e `notification_campaign_delivery` (both `always_on`), since F-027-o `network_traffic_rollup` (`15 3 * * *` — unscheduled, no daily aggregate is ever written and the raw partitions accumulate for ever), since F-027-y `grant_config_purge` (`20 * * * *` — unscheduled, a spent Grant's clients hold their panel seats for ever), since F-027-bl `grant_group_fulfilment` (`* * * * *` — unscheduled, a grouped Grant never activates), since F-111-a `invoice_pending_expiry` (`always_on` — unscheduled, an unpaid invoice holds its coupons for ever), and since F-111-d `grant_delivery` (`* * * * *` — unscheduled, a paid Grant is never delivered nor refunded).
Left unscheduled, a payment the bank took but never called back about is never
credited, which is the manual top-up legacy needed. The seed never touches a
job that already has a schedule.

**An internal answer is enveloped.** `auth-service` and `billing-service` send
every route, `/api/internal/*` included, through shared-core's
`ResponseInterceptor`: `{ ok, msg, data }`. A job reads its counts from
`data` via `automation/internal-answer.ts` (`envelopeData`), never the top
level — until 2026-09-14 all three HTTP jobs did, and each failed its first
real run the moment it was scheduled.

**One token opens every internal door, and widens nothing.** `SERVICE_AUTH_TOKEN`
says which *process* is calling and never which user, so the expiry job reuses
the credential the retention job already holds rather than introducing a second
one. The guard behind it is `shared-core`'s `ServiceOnlyGuard` since F-092-k;
`auth-service`'s own class of that name is its security middleware's other half,
and `bot-service`'s is a third copy that should collapse into the shared one.

**A job never succeeds quietly.** An unreachable service, a guard's 404 and an
answer in a shape the job does not recognise are each indistinguishable from
"nothing was due" if the run reports zero items and success. Each one throws,
so the consumer records `failed` (invariant #3). This is the rule a sweep needs
most: it is the kind of job nobody looks at while it is working.

## The admin surface (F-031-b)

Five routes under `/auth/workers`, in `auth-service`. Moved to
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

`GET /auth/workers/dead-letters` is the reading half, in `auth-service` for the
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
`POST /auth/workers/:key/run` answers 503, the shape it already used for an
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
