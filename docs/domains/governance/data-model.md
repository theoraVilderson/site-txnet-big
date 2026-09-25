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
| temporal_access_grant | extra permission/resource access for a window; `one_time` or `recurring_daily` | via grantee user | expires |
| user_restriction | per-user cap keyed by `restrictionKey`, JSON limit, soft-warning or hard-block | via user | until inactive/expired |
| user_group | a named set (F-114-j): `name` unique per tenant, `kind` (`manual`), `allTenants` (platform owner's only, trigger); `(id, tenantId)` unique — the key members and discount rules point at | `tenantId`, strict RLS | until deleted |
| user_group_member | one member: `memberType` `user` (`userId`) or `tenant` (`memberTenantId`, platform owner's only), CHECK one subject; `tenantId` is the group's | `tenantId`, strict RLS | with its group (cascade) |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| temporal_access_grant.granteeUserId, user_setting.userId, user_restriction.userId | -> | identity.user.id | all three are per identity |
| user_group_member.userId / memberTenantId | -> | identity.user.id / tenant.tenant.id | no foreign key (as `discount_rule_user`); checked on add, by the service and the trigger |
| billing.discount_rule.(groupId, tenantId) | -> | user_group.(id, tenantId) | billing's rule targets a group; `Restrict`. Billing reads `user_group_member` read-only at pricing |

## Access rules

No unit outside `governance` writes these tables. User groups are written only by
`UserGroupAdminService` (auth-service); billing reads a buyer's `user_group_member`
rows directly, read-only, under RLS — the one read outside the unit.

## Migration notes

User groups: `20260925001600_user_groups` (tables, RLS, trigger, `user_group.manage`).
For the three draft tables, any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
