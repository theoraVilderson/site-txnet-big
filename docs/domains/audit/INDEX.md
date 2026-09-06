---
id: audit
layer: domain
status: active
version: 2
keywords: [audit log, impersonation, account switch, account switching, multi account, multiple accounts, switch account, linked accounts, account group, switch scope, per device accounts, per chat accounts, remove an account, leave a group]
source:
  - txnet-backend/prisma/domains/audit.prisma
  - txnet-backend/auth-service/src/app/account-switch/**
owns_tables: [admin_audit_log, impersonation_session, linked_account_group, linked_account_member]
depends_on: [identity]
updated: 2026-09-06
---

# Audit

**Responsibility (one sentence):** the append-only trail of privileged actions: admin audit log, impersonation sessions, and user-initiated account-switch groups.
**Explicitly NOT responsible for:** authorising the action being logged (each domain), the impersonation *flow* (`identity` / `auth-api` drive it, `audit` owns the records).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing audit from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-06 | **ADR-0015 — a group belongs to the surface it was built on, not to the person.** `linked_account_member` gains `scopeKey` (`bot:<platform>:<chatId>` or `device:<uuid>`); `userId @unique` becomes `@@unique([scopeKey, userId])`. Contract v1 -> **v2**, breaking every switch-group operation. Invariant #3 rewritten, #8 added; #4/#6/#7 untouched. F-0208 (removing an account, from either side) ships with it and revokes only that scope's sessions (`account_unlinked`) |
| 2026-09-06 | The group is complete for a user: F-0206 (`GET /auth/accounts`) and F-0207 (`POST /auth/accounts/switch`) join F-0205. Invariants #6 and #7 stop being intent — the list and the switch both filter on the caller's `tenantId`, and the handover is one transaction in `identity` (`AuthService.switchSession`). `panel-web` renders it (F-0209). Still open in this area: F-0208 (leaving a group) |
| 2026-09-06 | First service: `account-switch/` implements F-0205 (add an account to the group, proved by OTP or password). Unit flips `draft` -> `active` — the switch-group half is live; `admin_audit_log` and `impersonation_session` are still written by identity's impersonation module and remain unserviced here |
| 2026-09-06 | Account switching specified (catalog 2.8, F-0205…F-0210): `audit` owns the group and its rules, `auth-api` exposes it, `panel-web` renders it. Invariants #4 amended (OTP **or** password), #6 (never crosses a tenant) and #7 (the outgoing session is revoked as the incoming one is issued) added. Still `draft` — no code yet |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
