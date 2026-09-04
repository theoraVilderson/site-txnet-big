---
id: identity
layer: domain
status: active
version: 1
keywords: [users, login, auth, rbac, roles, permissions, sessions, otp, telegram, bale, bot account]
source:
  - txnet-backend/prisma/domains/identity.prisma
  - txnet-backend/auth-service/src/app/auth/**
  - txnet-backend/auth-service/src/app/impersonation/**
owns_tables: [user, session, role, permission, role_permission, otp_code, linked_bot_account]
depends_on: [audit, i18n, redis-keyspace]
updated: 2026-09-04
---

# Identity

**Responsibility (one sentence):** who a User is, how they authenticate
(password / OTP), their RBAC role + permissions, their live sessions, and
their linked Telegram/Bale accounts.
**Explicitly NOT responsible for:** tenant staff roles (`tenant`), the edge
token check (`forward-auth`), admin audit records (`audit`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing identity from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [rules.md](rules.md) | implementing inside this unit |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Unit documented from existing auth-service + schema (onboarding) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
