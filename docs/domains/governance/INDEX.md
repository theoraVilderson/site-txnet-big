---
id: governance
layer: domain
status: active
version: 2
keywords: [settings, access grant, restriction, cap, user group, user groups, group of users, segment, /api/auth/user-groups]
source:
  - txnet-backend/prisma/domains/governance.prisma
  - txnet-backend/auth-service/src/app/governance/**
  - txnet-backend/prisma/domains/migrations/20260925001600_user_groups/**
owns_tables: [user_setting, temporal_access_grant, user_restriction, user_group, user_group_member]
depends_on: [identity, tenant]
updated: 2026-09-25
---

# Governance

**Responsibility (one sentence):** user groups (a tenant's named sets of users — and, for the platform owner, of resellers — that other units target), per-user key/value settings, time-boxed extra access grants (beyond the base role), and admin-imposed usage/spend caps on a user.
**Explicitly NOT responsible for:** tenant-level caps (`tenant`), the base RBAC role model (`identity`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing governance from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-25 | **draft -> active**, contract v2 (F-114-j): user groups — `/api/auth/user-groups`, served by auth-service; the first code of this unit. Consumer billing (discount rules' `groupId`) |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
