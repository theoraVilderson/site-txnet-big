---
id: ai
layer: domain
status: draft
version: 2
updated: 2026-10-02
---

# Contract — ai

**DRAFT — schema (F-038-a) and an empty `ai-service` (F-038-b): it boots,
holds its pools and consumes its trigger queue; nothing is decided yet.** The design
is ADR-0109; the series that builds it is F-038-b … F-038-w and catalog
area 24 (F-1501 … F-1550).

## TL;DR

Two layers. The **engine** is ours: per-account profiles → predictions with
reasons → a next best action → its timing → a template. It needs no model and
no key. The **language layer** is the tenant's own model (BYO-AI): it may
rephrase a template or re-rank inside the engine's candidates, never invent a
product, number or price. Both run in one service, `ai-service`, so every
guardrail has one home.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| rebuild profiles | hourly; a tenant | `account_profile`, `prediction` rows | async (`ai-service`) | — |
| decide | an outbox trigger or the hourly run | an `action` row: `scheduled`, `awaiting_approval` or `suppressed` (+ step) | async | — |
| record outcome | the purchase or top-up the action suggested, within 7 days | `action.status = accepted` | async | — |
| settings, offers, providers | tenant admin | `setting`, `offer`, `guardrail`, `provider`, `task_route` | sync (F-038-j, F-038-w) | — |

## Emits (events)

None yet. Delivery is a notice of class `suggestion` through `notification`
(F-038-g, ADR-0109 point 11).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | `ai_recommendation` feature key — no key, no engine run (F-1550) | no run |
| identity, billing, entitlement, catalog, tenant | the tables in `ai-service/src/app/reader/reader-tables.ts`, through `txnet_ai_reader` — SELECT only, `identity.user` by named columns, each under its tenant clause (ADR-0109 point 6) | that run is skipped; nothing is guessed |
| automation | `AI_TRIGGER_EVENTS` (`triggers/trigger-events.ts`) on its own queue `txnet.ai.triggers`; a bad envelope or a failed handler is dead-lettered, never requeued | profiles still rebuild hourly |

## Guarantees (intended)

- Every row is one tenant's (invariant 1); no learning across tenants.
- A suggestion never moves money, a meter or a payment (invariant 4).
- Without a provider, every message is a template (F-1540).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `user_behavior_event`, `ai_recommendation`, `ai_guardrail_rule`, `ai_guardrail_violation_log` | 2026-10-02 | removed (F-038-a) | `action`, `prediction`, `guardrail`, `offer` |
