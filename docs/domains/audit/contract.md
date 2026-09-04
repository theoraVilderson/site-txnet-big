---
id: audit
layer: domain
status: draft
version: 1
updated: 2026-09-04
---

# Contract — audit

**DRAFT — schema only, no service implements this yet.** Intent derived from
`txnet-backend/prisma/domains/audit.prisma`.

## TL;DR

The privileged-action trail. `admin_audit_log` is absolutely append-only (not even a super admin deletes rows) with `oldValue`/`newValue` JSON + admin IP. `impersonation_session` records an admin acting as a user (always paired with an `admin_audit_log` entry). `linked_account_group` + `linked_account_member` model a user's own verified account switching.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| append audit entry | adminId, action, target, old/new, ip | `admin_audit_log` row | sync (in caller tx) | — |
| read audit trail | target ref / admin / date range | rows (read-only) | sync | — |
| record impersonation start/end | adminId, targetUserId, reason, ticket? | `impersonation_session` (+ audit row) | sync tx | (see identity invariants) |
| manage account-switch group | userId(s), OTP | `linked_account_group` / members | sync | OTP not verified |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | actor + target identities, OTP verification for account linking | audit writes blocked -> caller tx aborts |

## Guarantees (intended)

- Audit writes participate in the caller's transaction — an action and its audit row commit or roll back together.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
