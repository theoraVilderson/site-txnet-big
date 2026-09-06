---
id: audit
layer: domain
status: active
version: 2
updated: 2026-09-06
---

# Contract — audit

**Partly implemented.** The account-switch group is live end to end for a
user (`auth-service/src/app/account-switch/`): adding (F-0205), listing
(F-0206), switching (F-0207) and removing (F-0208). The audit log and
impersonation records are still **intent only**: they are *written* by
identity's impersonation module, and no `audit` service reads or guards them
yet. Rows below are marked accordingly.

**Version 2 (2026-09-06, ADR-0015) is a breaking change to every switch-group
operation.** A group is no longer a property of the person: it belongs to the
**switch scope** — one bot chat, or one browser — that it was built on. Every
operation below now reads the caller's scope, and a caller whose scope cannot
be resolved is refused rather than served a global group. Consumers:
`auth-api`, and through it `panel-web` and `bot-app`; all three are updated in
the same change.

## TL;DR

The privileged-action trail. `admin_audit_log` is absolutely append-only (not even a super admin deletes rows) with `oldValue`/`newValue` JSON + admin IP. `impersonation_session` records an admin acting as a user (always paired with an `admin_audit_log` entry). `linked_account_group` + `linked_account_member` model a user's own verified account switching, **per surface** — `@@unique([scopeKey, userId])`, so the same person holds an independent set in each chat and each browser (ADR-0015).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| append audit entry *(intent)* | adminId, action, target, old/new, ip | `admin_audit_log` row | sync (in caller tx) | — |
| read audit trail *(intent)* | target ref / admin / date range | rows (read-only) | sync | — |
| record impersonation start/end *(written by identity today)* | adminId, targetUserId, reason, ticket? | `impersonation_session` (+ audit row) | sync tx | (see identity invariants) |
| add an account to a switch group **(live, F-0205)** | caller's session, **caller's scope**, target phone/username + an OTP to that account **or** its password | `linked_account_member` row carrying that scope, `verifiedViaOtp` set accordingly | sync | proof failed, already in a group *on this surface*, no resolvable scope (`accountSwitch.noScope`), rate-limited |
| list the caller's switch group **(live, F-0206)** | caller's session, **caller's scope** | the caller, plus the members of the caller's own tenant they may switch to **in this scope**; phone masked | sync | — (no scope and no group both answer `members: []`) |
| switch to a member **(live, F-0207)** | caller's session, **caller's scope**, target member | the target's token pair + `refresh_token` cookie, the new session stamped with the same scope; the caller's session revoked `account_switched` | sync tx | not a member *of this scope's group*, another group, cross-tenant, target deleted/suspended, no scope — all one answer, `accountSwitch.notAMember` |
| remove an account from the group **(live, F-0208)** | caller's session, **caller's scope**, target member — which may be the caller itself | that scope's member row gone; the removed account's sessions **in that scope** revoked `account_unlinked`; the group deleted if one member would be left | sync tx | not a member, no scope — both `accountSwitch.notAMember` |

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | actor + target identities, OTP/password verification for account linking, and the **session handover** a switch performs (`AuthService.switchSession`) | audit writes blocked -> caller tx aborts |

## Guarantees (intended)

- Audit writes participate in the caller's transaction — an action and its audit row commit or roll back together.
- A switch never widens what the caller can reach: the group is not a shared identity, so the new session carries the **target's** role and permissions and inherits nothing from the account being left.
- At no instant does a switching browser hold two live sessions, or a live session for an account it has not proved. See invariants #6 and #7.
- **No operation reaches outside the caller's scope.** Adding, listing, switching and removing all read `(scopeKey, userId)`, so a group built in a browser is invisible and unreachable from a chat and vice versa — including the removal's session revoke, which is narrowed to that scope (ADR-0015, invariant #8).
- The scope is never taken from a request body. It comes from the `device_id` cookie or from the verified service token plus the bot headers, so a caller cannot name the surface it is acting for.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| a single global group per user (`linked_account_member.userId` unique) | 2026-09-06 (ADR-0015) | removed in the same change — see below | one group per `(scopeKey, userId)` |

The one break not kept for a release: there is no production deployment and
`prisma/migrations/` does not exist yet (D-5), so the old shape has no consumer
to deprecate for. Existing dev rows were backfilled to the inert scope
`legacy:panel`.
