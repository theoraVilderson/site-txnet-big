---
id: TEMPLATE
layer: interface
status: draft
version: 1
updated: 2026-09-03
---

# Contract — <unit>

The **only** legal way other units interact with this one. If it is not here,
it is private. Target ≤200 lines; split the unit if it grows beyond that.

## TL;DR
Three lines max. What callers get from this unit.

## Provides
| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|

Field-level shapes live in code. Link, do not copy:
`see apps/api/src/modules/<x>/dto/`

## Emits (events)
| Event | Payload ref | When | Ordering/idempotency guarantees |
|---|---|---|---|

## Consumes
| From unit | What | Failure behaviour if unavailable |
|---|---|---|

## Guarantees
Latency, consistency, idempotency, retry semantics, at-least/at-most-once.

## Deprecations
| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
