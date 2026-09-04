---
id: governance
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — governance

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `user_setting` is unique per `(userId, key)` | planned service layer / schema | see contract | 
| 2 | A `recurring_daily` grant uses `dailyStartTime`/`dailyEndTime` + `timezone`; a `one_time` grant uses `startAt`/`endAt` — never both | planned service layer / schema | see contract | 
| 3 | `user_restriction` is logically unique per `(userId, restrictionKey)` on active rows only (needs a partial unique index — 'section 99') | planned service layer / schema | see contract | 
| 4 | A `hard_block` restriction is enforced before the action; a `soft_warning` only annotates | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
