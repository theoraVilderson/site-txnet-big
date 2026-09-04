---
id: audit
layer: domain
status: draft
version: 1
keywords: [audit log, impersonation, account switch]
source: []
owns_tables: [admin_audit_log, impersonation_session, linked_account_group, linked_account_member]
depends_on: [identity]
updated: 2026-09-04
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
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
