---
id: audit
layer: domain
status: active
version: 3
keywords: [audit log, impersonation, settlement, payout, grant a gateway, withdraw a grant, what is owed, operator surface, account switch, account switching, multi account, multiple accounts, switch account, linked accounts, account group, switch scope, per device accounts, per chat accounts, remove an account, leave a group]
source:
  - txnet-backend/prisma/domains/audit.prisma
  - txnet-backend/auth-service/src/app/account-switch/**
  - txnet-backend/billing-service/src/app/settlement/**
  - txnet-backend/prisma/domains/migrations/20260912000300_settlement_admin_actions/**
  - txnet-backend/prisma/domains/migrations/20260918000200_bot_scope_key_tenant/**
owns_tables: [admin_audit_log, impersonation_session, linked_account_group, linked_account_member]
depends_on: [identity]
updated: 2026-09-12
---

# Audit

**Responsibility (one sentence):** the append-only trail of privileged actions: admin audit log, impersonation sessions, and user-initiated account-switch groups.
**Explicitly NOT responsible for:** authorising the action being logged (each domain), the impersonation *flow* (`identity` / `auth-api` drive it, `audit` owns the records).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing audit from outside |
| [contract.settlement.md](contract.settlement.md) | the platform owner's back office over granted gateways: grants, what is owed, payouts |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-18 | Contract v2 -> **v3** (break, F-061-g, ADR-0059 (5)): a chat's scope is `bot:<tenantId>:<platform>:<chatId>` (migration `20260918000200`, existing rows rewritten; `forward-auth` updated in the same change, reads both). Invariant #6 is now "the door admits": a reseller's owner switches among their reseller's accounts on its domain |
| 2026-09-12 | **The settlement operator surface (F-096-e, ADR-0041 §5/§6)** — `contract.settlement.md`, additive, no version bump. Five routes under `/api/billing/admin/settlement/*`: grant a gateway, withdraw one, list grants, what is owed per tenant, record a manual payout. Invariants **#9–#11** added, the unit's first enforced outside `auth-service`. Two new `AdminAction`s and `AuditTargetType`s; `billing-service` becomes the second writer of `admin_audit_log` |
| 2026-09-06 | **ADR-0015 — a group belongs to the surface it was built on, not to the person.** `linked_account_member` gains `scopeKey` (`bot:<platform>:<chatId>` or `device:<uuid>`); `userId @unique` becomes `@@unique([scopeKey, userId])`. Contract v1 -> **v2**, breaking every switch-group operation. Invariant #3 rewritten, #8 added; #4/#6/#7 untouched. F-0208 (removing an account, from either side) ships with it and revokes only that scope's sessions (`account_unlinked`) |
| 2026-09-06 | The group is complete for a user: F-0206 (`GET /auth/accounts`) and F-0207 (`POST /auth/accounts/switch`) join F-0205. Invariants #6 and #7 stop being intent — the list and the switch both filter on the caller's `tenantId`, and the handover is one transaction in `identity` (`AuthService.switchSession`). `panel-web` renders it (F-0209). Still open in this area: F-0208 (leaving a group) |
| 2026-09-06 | First service: `account-switch/` implements F-0205 (add an account to the group, proved by OTP or password). Unit flips `draft` -> `active` — the switch-group half is live; `admin_audit_log` and `impersonation_session` are still written by identity's impersonation module and remain unserviced here |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
