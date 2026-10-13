---
id: governance
layer: domain
status: draft
updated: 2026-09-25
---

# Data model — governance

Source of truth: `txnet-backend/prisma/domains/governance.prisma` (Postgres schema
`governance`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| user_setting | `(userId, key)` unique KV, JSON value, category-tagged | via user | latest |
| user_restriction | per-user cap keyed by `restrictionKey`, JSON limit, soft-warning or hard-block | via user | until inactive/expired |
| user_group | a named set (F-114-j): `name` unique per tenant, `kind` (`manual`), `allTenants` (platform owner's only, trigger); `(id, tenantId)` unique — the key members and discount rules point at | `tenantId`, strict RLS | until deleted |
| user_group_permission | one extra key a group gives its user members (AC-1-m); PK `(groupId, permissionId)`; FK on the group's `(id, tenantId)` cascade | `tenantId`, strict RLS | with its group (cascade) |
| user_group_member | one member: `memberType` `user` (`userId`) or `tenant` (`memberTenantId`, platform owner's only), CHECK one subject; `tenantId` is the group's; `expiresAt` optional, an ended one counts for nothing (`liveMembership`, ADR-0139 (3)) | `tenantId`, strict RLS | with its group (cascade) |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| user_setting.userId, user_restriction.userId | -> | identity.user.id | both are per identity |
| user_group_member.userId / memberTenantId | -> | identity.user.id / tenant.tenant.id | no foreign key (as `discount_rule_user`); checked on add, by the service and the trigger |
| user_group.roleId, user_group_permission.permissionId | -> | identity.role.id, identity.permission.id | what a group gives (AC-1-m); role RESTRICT (`role.inUse`), permission cascade |
| billing.discount_rule.(groupId, tenantId) | -> | user_group.(id, tenantId) | billing's rule targets a group; `Restrict`. Billing reads `user_group_member` read-only at pricing |

## Access rules

No unit outside `governance` writes these tables. User groups are written only by
`UserGroupAdminService` (auth-service); billing reads a buyer's `user_group_member`
rows directly, read-only, under RLS — the one read outside the unit.

## Migration notes

User groups: `20260925001600_user_groups` (tables, RLS, trigger, `user_group.manage`).
Group access: `20261009000600_a_group_holds_access` (`roleId`, `user_group_permission`, notify triggers).
For the three draft tables, any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
