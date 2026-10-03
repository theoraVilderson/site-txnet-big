---
id: fraud
layer: domain
status: active
version: 2
updated: 2026-10-03
---

# Contract — fraud

**Partly built.** The device fingerprint is (F-036-a): a module of
`billing-service`, `billing-service/src/app/fraud/device-fingerprint.ts`,
called in the caller's transaction. Flags, scanners and the blocklist are
still schema only (F-036, catalog §19.4).

## TL;DR

Cross-cutting anti-fraud, intentionally its own schema. `device_fingerprint` (D-11's recipe, below) counts the accounts seen in one place. Periodic `automation` scanners create `fraud_flag` rows (subject type/id, flag type, severity, optional auto-action). A full ban is an admin decision except for `severity = critical`.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| **built** `fingerprintSourceOf(req)` | the request | a web or bot source, or `null` — the caller then refuses what needs one | sync | — |
| **built** `recordFingerprint(tx, …)` | tenantId, userId, source, at | `{id, fingerprintHash}`: one row per (tenant, account, hash), `lastSeenAt` moved | sync, caller's tx | — |
| **built** `accountsOnFingerprint(tx, …)` | tenantId, fingerprintHash, at | distinct accounts with `lastSeenAt` in the 30 days to `at` | sync, caller's tx | — |
| **built** `fingerprintVerdict(n)` | that count | `clear` < 3 ≤ `flag` < 5 ≤ `refuse_free_grants` (D-11) | sync | — |
| raise flag | subjectType, subjectId, flagType, severity | `fraud_flag` (+ optional auto action) | async (scanner) | — |
| resolve flag | flagId, adminId, notes | updated flag | sync | — |
| list open flags | filters | flags | sync | — |

## The recipe (D-11)

- **Web:** sha256 of `["web", ip, User-Agent, device_id]`. `device_id` is the
  cookie `auth-service` mints (host-only, path `/`, name in
  `contracts/http/wire.json`); `ip` is Express's, behind `trust proxy`
  (`TRUST_PROXY`, one hop by default). No cookie or no ip: no fingerprint.
- **Bot / Mini App:** sha256 of `["bot", platform, platform user id]`, from the
  gate's `X-Chat-Platform` / `X-Chat-User-Id` — never bot-service's address.
- A JSON array, so no component can run into its neighbour; the channel leads.
- Per tenant: a count never crosses tenants. 5 refuses **free grants only**
  (trial, wheel — ADR-0111 point 3); login and purchase are never refused.

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` for fingerprints and user-subject flags | fingerprinting/flagging degraded |
| auth-service | the `device_id` cookie it mints | no web fingerprint: the free grant is refused |

## Guarantees (intended)

- Auto-actions are reversible protective holds, not deletions.
- A fingerprint is a signal, never an identity or a credential: it refuses
  free grants and raises flags, nothing else.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
