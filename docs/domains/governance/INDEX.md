---
id: governance
layer: domain
status: active
version: 6
keywords: [group access, a group holds a role, give a group permissions, دسترسی گروه, settings, display preferences, ui preferences, motion level, pinned pages, restriction, cap, user restriction, restrict one user, max active services, max configs, barred top-up method, محدودیت کاربر, سقف سرویس کاربر, روش شارژ ممنوع, user group, user groups, group of users, segment, /api/auth/user-groups]
source:
  - txnet-backend/prisma/domains/governance.prisma
  - txnet-backend/auth-service/src/app/governance/**
  - txnet-backend/prisma/domains/migrations/20260925001600_user_groups/**
  - txnet-backend/prisma/domains/migrations/20261009000600_a_group_holds_access/**
  - txnet-backend/prisma/domains/migrations/20261009001000_seats_and_staff_roles_become_groups/**
  - txnet-backend/prisma/domains/migrations/20261013000600_a_restriction_on_one_person/**
  - txnet-backend/shared-core/src/lib/governance/user-restrictions.ts
  - txnet-backend/shared-core/src/lib/governance/audience-groups.ts
owns_tables: [user_setting, user_restriction, user_group, user_group_member, user_group_permission]
depends_on: [identity, tenant]
updated: 2026-10-14
---

# Governance

**Responsibility (one sentence):** user groups (a tenant's named sets of users — and, for the platform owner, of resellers — that other units target), per-user key/value settings, and admin-imposed usage/spend caps on a user.
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
| 2026-10-14 | Contract v5 -> **v6** (GR-1-w, ADR-0143): who may pick a group as an audience — one rule in shared-core, new key `user_group.read`, `audience_not_allowed` on the five billing writes, the picker's list. [contract.md](contract.md). Consumers: billing, catalog, engagement (same change), auth-api (v54), panel-web (GR-1-x), notification (GR-1-y) |
| 2026-10-13 | Contract v4 -> **v5** (additive, F-030-d): restrictions on one person — `user_restriction` rebuilt on the person's tenant (strict RLS), the `USER_RESTRICTIONS` registry, set / change / lift under `restriction.assign`, audited; `temporal_access_grant` dropped (F-030-a). [contract.md](contract.md). Consumers: auth-api (v52), billing (F-030-e), panel-web (F-030-f) |
| 2026-10-09 | Contract v3 -> **v4** (additive, AC-1-m, ADR-0138): a group holds access — a role and/or keys its own tenant's user members hold; `PUT /auth/user-groups/:id/access`; member changes on such a group ask the giver's keys and authority; `group_access` told. [contract.md](contract.md). Consumers: identity (`AccessReader` reads it), auth-api (v46), panel-web (AC-1-o) |
| 2026-10-05 | Contract v2 -> **v3** (additive, UX-1-k): display preferences — four `ui.*` keys in `user_setting`, `/api/auth/me/ui-preferences`, served by auth-service. Consumer panel-web (UX-1-l, not built yet) |
| 2026-09-25 | **draft -> active**, contract v2 (F-114-j): user groups — `/api/auth/user-groups`, served by auth-service; the first code of this unit. Consumer billing (discount rules' `groupId`) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
