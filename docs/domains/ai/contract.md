---
id: ai
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — ai

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/ai.prisma`.

## TL;DR

A recommender with a money guardrail. `user_behavior_event` is a high-volume partitioned stream. A worker turns it into `ai_recommendation`s (renew, buy add-on, apply coupon, upgrade, retention offer) with a confidence score and revenue/cost estimates. Before a recommendation is shown, `ai_guardrail_rule`s can block or cap it; violations are logged.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| ingest behavior event | userId, eventType, payload | `user_behavior_event` | async, batched | — |
| generate recommendations | userId / batch | `ai_recommendation` rows (`proposed`) | async (worker) | — |
| fetch recommendations for user | userId | recommendations that passed guardrails (`shown_to_user`) | sync | — |
| record outcome | recommendationId, accepted/dismissed | updated status | sync | — |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` | no personalization |
| billing | current balance / spend / discount budget for guardrails + estimates | guardrails fail closed (block) |
| automation | the generation worker | no new recommendations |

## Guarantees (intended)

- Guardrails fail closed: if the budget/consumption check cannot run, the recommendation is blocked.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
