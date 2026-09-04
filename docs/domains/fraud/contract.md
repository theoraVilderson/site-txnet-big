---
id: fraud
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — fraud

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/fraud.prisma`.

## TL;DR

Cross-cutting anti-fraud, intentionally its own schema. `device_fingerprint` (hash of UA + canvas + IP subnet) detects many users on one device. Periodic `automation` scanners create `fraud_flag` rows (subject type/id, flag type, severity, optional auto-action). A full ban is an admin decision except for `severity = critical`.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| record fingerprint | userId, fingerprint components | `device_fingerprint` (upsert last-seen) | sync | — |
| raise flag | subjectType, subjectId, flagType, severity | `fraud_flag` (+ optional auto action) | async (scanner) | — |
| resolve flag | flagId, adminId, notes | updated flag | sync | — |
| list open flags | filters | flags | sync | — |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` for fingerprints and user-subject flags | fingerprinting/flagging degraded |

## Guarantees (intended)

- Auto-actions are reversible protective holds, not deletions.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
