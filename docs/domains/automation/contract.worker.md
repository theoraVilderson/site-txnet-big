---
id: automation
layer: domain
status: active
version: 5
updated: 2026-09-09
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

## The per-tenant cap (F-066-p, catalog 20.2 layer 4)

`AUTOMATION_PREFETCH` bounds how much this process runs at once, and it bounds
it **in total**. That is throughput control, not isolation: one tenant with a
thousand due occurrences takes every slot, and every other tenant's schedule
stops firing. The failure arrives as "the campaign never sent", which is the
shape of isolation bug nobody reports as one.

`AUTOMATION_TENANT_CONCURRENCY` caps how many of those slots **one tenant** may
hold. A tick that names no tenant is never gated — the heartbeat and the vault
retention sweep are platform work, and charging them to a tenant would let the
platform exhaust a reseller's budget.

**Nothing publishes a tenant-scoped tick yet.** `TickMessage.tenantId` is
optional and neither publisher sets it, so the cap binds on no traffic today. It
is built first on purpose: the alternative is that the first per-tenant job
arrives carrying a fairness policy of its own, which is how each job ends up
with a different one.

**A refused tick goes back on the exchange, behind everything else.** The three
things it could do instead are each worse in a way worth naming:

- *Waiting for a slot* inside the handler holds one of `AUTOMATION_PREFETCH`'s
  slots while running nothing. Fill them all with one tenant's waiting work and
  the queue stops draining for everyone — the exact failure the cap exists to
  prevent.
- *Nacking with requeue* returns it to the **head** of the queue, so it is
  redelivered at once, refused again, and spins at broker speed.
- *Dropping it* loses work silently, and an `admin_manual` run has no next
  occurrence to recover it.

Republishing puts it behind every other tenant's queued work, which is the
fairness the cap is for, and the `deferrals` count on the message makes the
yielding a log line rather than a gap.

**A deferral is not a run.** It opens no `bot_execution_log` row (invariant #3),
so counting rows still counts attempts. Past `MAX_DEFERRALS` — twenty, a
constant rather than a variable — the tick is given up on with an `error` line;
a cron occurrence is re-published by the next tick anyway.

**The cap is per process**, the same grain `AUTOMATION_PREFETCH` already has: N
replicas give a tenant N budgets. Stated rather than solved — a shared counter
means a Redis connection this service does not have, added for traffic that does
not exist yet, and the shape that would actually replace it is a queue per
tenant, which is a topology decision rather than a knob.

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

Five routes under `/admin/workers`, all behind `worker.manage`. They are in
`auth-service` because `worker-service` serves no HTTP by design (ADR-0027) and
because this is the process that already authenticates an admin — the two meet
at the three tables and at one exchange, and nowhere else.

A worker is addressed by its **`key`**, never by its uuid: the key is what the
job class declares, what invariant #4 protects, and the routing suffix of the
tick, so it is the identifier an operator reading a log already has.

**The write surface holds invariant #2 where a person can be told about it.**
Before this, a `bot_schedule` row could only be typed in by hand, so a shape
that could never run was both reachable and unreportable — the publisher
declined it into a log nobody reads. `set schedule` calls the same
`scheduleShapeError` the publisher calls and refuses with the rule that was
broken; `list workers` answers a `shapeError` per schedule, so a row already in
the table is visible too.

**Nothing is deleted.** A schedule is switched off, not removed:
`bot_execution_log` explains past runs and `setByAdminId` says who asked for
them, and deleting the row that explains a run leaves the history unreadable.

**`run now` is a publish, not a call.** The route answers "asked for", never
"finished" — the run happens in `worker-service`, which is what keeps the log
row, the timeout and the redelivery in one place (invariant #3). The broker
connection is opened lazily and `RABBITMQ_URL` is optional in `auth-service`:
this process answers `/auth/login`, and a broker that is down must fail that one
route rather than the boot.

**A failed run is nacked without requeue.** Requeueing spins a permanently
failing job at broker speed, which starves everything behind it. The failure is
not lost — it is a `bot_execution_log` row with `status = failed` — and the next
tick arrives on the next interval anyway.
