---
id: engagement
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — engagement

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/engagement.prisma`.

## TL;DR

A daily spin wheel. Two protections always apply: a hard daily budget cap (`dailyBudgetCapAmount`, independent of probabilities) and strict eligibility (min account age, min total purchase, min completed orders, active service now, per-user cooldown, max spins/day). Every attempt snapshots the result of all checks.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| get wheel state | userId | eligibility result + prizes + remaining daily budget | sync | — |
| spin | userId, deviceFingerprintId | `spin_wheel_attempt` + prize + wallet tx (if credit) | sync tx | ineligible, cooldown, cap reached |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` | spin blocked |
| fraud | device fingerprint for the attempt | spin blocked (fingerprint required) |
| billing | credit the wallet for a `wallet_credit` prize | prize voided / not awarded |

## Guarantees (intended)

- Eligibility is evaluated fresh on every spin from live data, then frozen into the attempt.
- Prize selection respects `probabilityWeight` and `dailyStockLimit`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
