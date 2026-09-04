---
id: ai
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — ai

**DRAFT** — extracted from schema comments; none are enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | A recommendation is shown to a user only after every active `ai_guardrail_rule` passes (or the recommendation is `blocked_by_guardrail` / capped) | planned service layer / schema | see contract | 
| 2 | Every guardrail block or cap writes an `ai_guardrail_violation_log` row | planned service layer / schema | see contract | 
| 3 | `user_behavior_event` is append-only and partitioned; old partitions are dropped, not row-deleted | planned service layer / schema | see contract | 
| 4 | Guardrails bound real money exposure: total daily AI-driven discount never exceeds `max_daily_discount_budget_total` | planned service layer / schema | see contract | 
| 5 | A recommendation never itself moves money — it only proposes an action a user must accept | planned service layer / schema | see contract | 

## How to test

To be written when a service exists.
