---
id: engagement
layer: domain
status: draft
version: 1
updated: 2026-10-02
---

# Contract — engagement

**DRAFT — the spin wheel is schema only. The attention budget is implemented
(F-1501), in `ai-service`, its only writer (ADR-0109 point 10).**

## TL;DR

A daily spin wheel. Two protections always apply: a hard daily budget cap (`dailyBudgetCapAmount`, independent of probabilities) and strict eligibility (min account age, min total purchase, min completed orders, active service now, per-user cooldown, max spins/day). Every attempt snapshots the result of all checks.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| get wheel state | userId | eligibility result + prizes + remaining daily budget | sync | — |
| spin | userId, deviceFingerprintId | `spin_wheel_attempt` + prize + wallet tx (if credit) | sync tx | ineligible, cooldown, cap reached |
| peek — **implemented (F-038-e)** | `AttentionBudget.peek(subject, now, pendingSends)`, the decision pipeline's budget step | the same verdict as `spend`, counting `pendingSends` as charged now; reads only, charges nothing, no lock | sync | — |
| spend attention — **implemented (F-1501)** | `AttentionBudget.spend({tenantId, kind, id}, origin, now)`, inside `ai-service` only | `{allowed: true, charged}` or `{allowed: false, limit: per_day \| per_week, retryAt}` | sync tx | — |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` | spin blocked |
| fraud | device fingerprint for the attempt | spin blocked (fingerprint required) |
| billing | credit the wallet for a `wallet_credit` prize | prize voided / not awarded |

## The attention budget (F-1501) — implemented

`ai-service/src/app/attention/`. A subject (`user`, or a reseller as `tenant`)
may be charged once in any 24 h and three times in any 7 days, both windows
rolling from each charge, never by calendar day (`ATTENTION_WINDOWS`). `spend`
inserts the row if missing, locks it `FOR UPDATE`, checks, and charges in one
tenant-bound transaction: two decisions racing for one subject cannot both
take the last slot. A refusal writes nothing; `retryAt` is when both windows
have room. Charges older than 7 days are dropped on the next charge. A count,
never money (C-13). No other service reads or writes the table. Only an
`engine` origin is charged; a `reply` is allowed and touches nothing (F-1502).

## Guarantees (intended)

- Eligibility is evaluated fresh on every spin from live data, then frozen into the attempt.
- Prize selection respects `probabilityWeight` and `dailyStockLimit`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
