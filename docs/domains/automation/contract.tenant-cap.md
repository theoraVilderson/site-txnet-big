---
id: automation
layer: domain
status: active
version: 6
updated: 2026-09-10
---

# Contract — automation: the per-tenant run cap

The §10 split of `contract.worker.md`, which reached 274 lines when F-067-e
made the cap a shared one. Everything here is catalog 20.2 layer 4 — how one
tenant's background work is stopped from occupying every slot this platform
has. The rest of the worker runtime is next door; the rule itself is
`invariants.md` #8.

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

**The count is shared, not per process** (F-067-e, D-17). F-066-p kept it in a
`Map` on the process, which is the grain `AUTOMATION_PREFETCH` has and the wrong
grain for a cap: N replicas gave a tenant N budgets, so the control stopped
meaning anything at exactly the scale it exists for. It lives in Redis now,
which is the dependency `worker-service` gained for it — `REDIS_URL` is
required, and `env.validation.ts` says why that one is not optional like a
job's.

**A slot is a lease, not a decrement.** The key is a sorted set of lease tokens
scored by the moment each expires (`automation:tenant-runs:<tenantId>`), and
`INCR`/`DECR` was rejected for a reason worth stating: a replica killed mid-run
never decrements, so the tenant's budget shrinks permanently and nothing would
ever restore it. The cap would degrade into a lockout, silently, for whichever
tenant had the bad luck. A lease expires instead — at
`AUTOMATION_RUN_TIMEOUT_MS`, deliberately the same deadline `closeAbandonedRuns`
writes the run row off at, so the slot and the row stop being real together.

Taking a lease is one Lua script — prune the expired, count, add if under the
cap — because read-then-write from N replicas is a lost update, and here the
lost update is a tenant holding `cap + 1` slots, which is this row's own bug one
layer down. A tick that names no tenant costs no round trip at all: it is not
gated, and that is every tick this platform publishes today.

**A Redis that cannot be reached degrades rather than refuses**
(`ASSUMED(2026-09-10)`). The gate falls back to counting in its own process —
F-066-p's cap, weaker than the shared one and much stronger than none. Deferring
on a Redis error is the tidier answer and the wrong one: every tenant tick would
yield and then dead-letter after `MAX_DEFERRALS`, turning a fairness control into
an outage for exactly the tenants it protects. The lease records which side
granted it, so it is handed back where it came from, and `release` never throws
— a Redis failure there must not replace the job's own outcome, and the lease
expires by itself anyway.

The shape that would replace all of this is still a queue per tenant, which is a
topology decision rather than a knob. F-067-b's per-chat queue set may make it
cheap; it is not this row.
