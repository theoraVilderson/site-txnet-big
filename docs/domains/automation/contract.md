---
id: automation
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — automation

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/automation.prisma`.

## TL;DR

Every background worker is a `bot_worker` row (with a `key` like `fraud_scanner`, `traffic_aggregator`, `tenant_usage_metering`). `isActive=false` is the fastest kill switch. Schedules are `always_on`, `time_window`, or `cron_expression`. Each run writes a `bot_execution_log`.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| register worker | key, name, category | `bot_worker` | sync | duplicate key |
| set schedule | botWorkerId, type, window/cron, timezone | `bot_schedule` | sync | invalid cron |
| toggle worker | botWorkerId, isActive | updated row + audit | sync | — |
| record run | botWorkerId, trigger, metrics | `bot_execution_log` | async | — |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| (none in schema) | workers call into other domains, but no FK dependency | — |

## Guarantees (intended)

- Toggling `isActive` takes effect on the next scheduler tick.
- `triggeredBy` distinguishes `cron` / `admin_manual` / `event` runs.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
