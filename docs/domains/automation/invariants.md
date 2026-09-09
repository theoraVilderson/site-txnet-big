---
id: automation
layer: domain
status: active
updated: 2026-09-09
---

# Invariants — automation

#8 arrived with F-066-p and is held by `TenantConcurrencyGate`.
#1–#4 were extracted from schema comments and were unenforced until F-031-a.
#1–#3 are now held by `worker-service`, at the one call site each; #4 is held by
the schema and re-checked on boot. #5–#7 arrived with `bot_integration`
(F-066-h) and are enforced in the schema and the migration.

#1 and #2 are held by pure functions in `@txnet-backend/shared-core`
(`shared-core/src/lib/automation/schedule.ts`) rather than inside
`worker-service`, and that is F-031-b's doing: two processes now decide about a
schedule — the tick publisher asking whether one came due, and the admin
surface refusing to write one that never could. An Nx app cannot import another
Nx app, so the alternative was the rule existing twice, which is the drift
these two invariants are about.

Invariant #2 deserves a note, because the schema **cannot** hold it: every one
of `windowStartAt`, `windowEndAt` and `cronExpression` is nullable, since each
is required by exactly one of the three `scheduleType` values. A row satisfying
none of the three shapes is therefore reachable by hand, and what it must not
do is fall back to running always. It never runs, and the tick publisher logs
which shape rule it broke.

Since F-031-b the shape is also checked at the moment it is **written**
(`POST /admin/workers/:key/schedules`), and the refusal names the rule that was
broken. The runtime check stays: a row typed straight into Postgres still
reaches the publisher, so the write surface is the place a person is told, not
the place the invariant is held.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `bot_worker.isActive = false` stops all runs of that worker regardless of schedule | `workerIsRunnable` (`shared-core/src/lib/automation/schedule.ts`) — the first thing `workerIsDue` calls, and the same check the admin manual trigger makes before it publishes, so the switch is read in one place however a run was asked for | an admin switches a campaign sender off and it sends anyway — the fastest kill switch is the one nobody can trust | 
| 2 | `bot_schedule` fields are mutually exclusive per `scheduleType` (window fields vs `cronExpression`) | `scheduleShapeError` — the schema cannot, see above. A malformed row never runs, and since F-031-b the admin surface refuses to create one | a schedule means something other than what was typed: a window silently ignored, a cron read as "always" | 
| 3 | Every run appends exactly one `bot_execution_log` (start), updated on finish — runs are never silent | `TickConsumer`, which opens the row **before** calling the handler and closes it in both the success and the failure path | the run an operator most needs to see — the one that crashed the process — is the one that left no trace | 
| 4 | `bot_worker.key` is unique and stable — it is referenced by string | `@@unique` on the column; `WorkerRegistryService` refuses to construct if two jobs claim one key, and `key` is also the `automation.tick.<key>` routing suffix, so a rename stops matching its own tick at once | two jobs share a run history, or a renamed job ticks a stale row for ever | 
| 5 | **Exactly one `primary` bot per `(tenantId, platform)`** (C-05) | the partial unique index `bot_integration_one_primary_per_tenant_platform`, in the database | "send this tenant's OTP" picks whichever row the planner found first — a code goes to the wrong brand's bot, silently | 
| 6 | A `bot_integration` row holds **no secret** — not a token, not a webhook secret. `credentialRef` names a vault label; the value is fetched through the vault, which audits the read (ADR-0026) | schema shape: there is no column to select | a token in a `SELECT *`, a log line or an admin response, for every tenant at once | 
| 8 | No tenant holds more than `AUTOMATION_TENANT_CONCURRENCY` of a worker process's run slots, and a tick refused by that cap is **returned to the exchange**, never dropped and never held | `TenantConcurrencyGate.admit` / `.release`, asked before any `bot_execution_log` row is opened, released in a `finally` so a throwing job cannot leak a slot | one tenant's backlog occupies every slot and every other tenant's schedule silently stops firing — catalog 20.2 layer 4, and the half of it that fails as "the campaign never sent" rather than as an error | 
| 7 | `webhookPath` is globally unique and is the whole address — resolving it yields the tenant and the platform, and nothing about the sender is trusted before it does (ADR-0009) | `@@unique` on the column | a shared door: one bot's token or ban problem becomes an outage for every reseller | 

## How to test

#1 and #2 are stated by `shared-core/src/lib/automation/schedule.spec.ts`,
against `workerIsDue` and `scheduleShapeError` directly — both are pure
functions of a row and two timestamps, so neither a broker nor a Postgres is
needed to say what they must do.

`auth-service/src/app/automation/worker-admin.service.spec.ts` states the same
two at the write surface: a malformed schedule is refused with the rule it
broke and nothing is written, and a manual run of a worker with
`isActive = false` publishes nothing.

#8 is stated by
`worker-service/src/app/automation/tenant-concurrency.gate.spec.ts`, against the
gate directly. The gate is a plain object with no broker and no database in it
precisely so that this is possible: what must be true is arithmetic about who is
in flight, and the two side effects around it — running the handler, putting a
refused tick back — belong to the consumer. The case the spec exists for is the
silent one: a refused tick that is neither run nor returned is work that
disappears, and nothing downstream reports it.

#3 is still not covered by a spec. F-031-b makes it *reachable* — `POST
/admin/workers/:key/run` is a way to start a run on demand — but asserting it
needs a real broker and a real `bot_execution_log` to count rows in, which is
the `*.int.spec.ts` tier and a fixture this repo does not have yet (the
Postgres fixture exists; a RabbitMQ one does not). Stated as an open gap rather
than half-built.
