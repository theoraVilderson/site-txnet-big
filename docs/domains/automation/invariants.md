---
id: automation
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — automation

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `bot_worker.isActive = false` stops all runs of that worker regardless of schedule | planned service layer / schema | see contract | 
| 2 | `bot_schedule` fields are mutually exclusive per `scheduleType` (window fields vs `cronExpression`) | planned service layer / schema | see contract | 
| 3 | Every run appends exactly one `bot_execution_log` (start), updated on finish — runs are never silent | planned service layer / schema | see contract | 
| 4 | `bot_worker.key` is unique and stable — it is referenced by string | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
