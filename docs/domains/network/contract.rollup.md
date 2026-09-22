---
id: network
layer: domain
status: active
version: 1
updated: 2026-09-21
---

# The nightly rollup, and the order it must keep

What governs `network_traffic_rollup` (F-027-o): the job that turns raw traffic
into `traffic_daily_aggregate` and then drops the raw months it has covered.
Read it before changing retention, before changing what the aggregate means, or
before writing anything else that drops a partition.

**The invariant is an ordering.** *The daily aggregate is committed before its
source raw partition is dropped* (invariant 3). Backwards, the loss is
permanent and silent: `DROP TABLE` on a partition leaves nothing to recompute
from, and the month reads as zero traffic ever after — no error, no gap, just a
quiet period in every report that crosses it.

## Three functions, and a clock

The work is SQL, in
`20260921000900_the_rollup_commits_before_the_partition_drops`. The job calls
it and decides nothing.

| function | what it does |
|---|---|
| `network.roll_up_traffic(from, to)` | one `INSERT … SELECT` per `(configId, date)` over the half-open window; returns rows written |
| `network.drop_traffic_raw_log_partition(month)` | **refuses** unless the aggregate already matches the partition, then drops it; returns the name, or `NULL` if there was none |
| `network.ensure_traffic_raw_log_partition(month)` | rolls the months forward, policying what it creates (F-027-ak) |

All three are `SECURITY DEFINER`, and neither reason is convenience.
`traffic_raw_log` carries FORCE RLS since F-027-ak with policies `TO txnet_app`
and `TO txnet_cross_tenant`, so a rollup — platform-wide by definition, binding
no `app.tenant_id` — reads an empty table as the application role; the same
argument `billing.coupons_over_limit()` makes for the exporter. And creating or
dropping a partition is DDL, which `txnet_app` has no privilege for at all: the
creator function has in fact never been callable by the job it was written for.

**Summing a month belongs next to the rows.** Pulling the highest-volume table
in the platform across the wire to add it up in a process is the same answer
for several orders of magnitude more work.

## The refusal is the mechanism

The drop counts the `(configId, date)` groups in the partition whose aggregate
row is **missing or does not match**, and raises if there are any.

Equality, not existence, because the failure that survives review is the stale
one: an aggregate rolled up before the month's last rows landed is individually
plausible, and so is the dropped partition. Only comparing them says so. The
current month and any future one are refused outright.

A refused drop **fails the run** (`bot_execution_log`, automation invariant #3)
and the job stops there rather than going on to the next month. Dropping every
other month behind one that could not be verified is how a reporting gap
becomes several.

## Applied twice is applied once

`roll_up_traffic` upserts on `(configId, date)` — invariant 30's unique key —
and **replaces** the day's totals rather than adding to them. A rerun is
therefore the same answer, and a row that arrived after an earlier rollup is
picked up by the next one. That is what lets the job re-roll a recent window
(`TRAFFIC_ROLLUP_LOOKBACK_DAYS`, 3 days including today) on every run: a night
the job did not run repairs itself, without an operator deciding anything.

The month about to be dropped is rolled up again immediately before the drop is
asked for, in the same loop iteration — so a late row is in the aggregate that
the drop then checks, rather than in the partition it removes.

## Where it lives

A `Job` in `worker-service`, not a timer in `metering-service` (ADR-0027).
Every scheduled thing on this platform is a job there, with the
`bot_execution_log` row, the tenant gates and the dead-letter drain that come
with being one; `metering-service` consumes `network.usage.#` and holds a
broker, two pools and nothing else (`domains/billing/contract.metering.md`).

It reaches its work through Prisma rather than an internal HTTP seam
(`vault-retention.job.ts`), because the seam would be a route wrapping one
`SELECT` of a function the database already exposes — and there is no service
that owns this schema to put the route on.

**Seeded** at `15 3 * * *` (`prisma/seed.js`): unscheduled, the aggregate is
never written and the raw partitions accumulate for ever, which is the
retention rule describing something nobody does.

## Retention

`TRAFFIC_RAW_RETENTION_MONTHS` (3) is how many whole months of raw rows are
kept. The partitions older than that are found in the catalogue rather than
derived from a calendar — a month created by hand, or one a stopped job never
covered, is a table this has to know about.

Lowering it cannot lose traffic data, because the drop is refused unless the
aggregate matches; what it loses is the per-pass detail a dispute would be
settled from. A dropped month is still readable in `traffic_daily_aggregate`,
per day and per config.
