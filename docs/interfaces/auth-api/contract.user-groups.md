---
id: auth-api
layer: interface
status: active
version: 33
updated: 2026-09-25
---

# Contract — auth-api / user groups

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. The wire shapes of `/api/auth/user-groups`, where an admin
manages its tenant's user groups (F-114-j). The rules — who a group may hold,
what "a reseller member" means, why the permission is not the boundary — are
[governance/contract.md](../../domains/governance/contract.md) "User groups";
this file is shapes, codes and limits.

Field schemas live in code:
`txnet-backend/auth-service/src/app/governance/user-groups/user-group.schema.ts`.

## Routes

Every route needs a **Bearer** token and `user_group.manage` (`Admin`;
SuperAdmin as `*`), and acts on the **session's tenant** — nothing takes a
`tenantId`. Bodies are `.strict()`. A `group` is
`{id, name, kind, allTenants, userCount, tenantCount, createdAt, updatedAt}`;
`kind` is `manual`.

| Route | Body / query | Answers | Rate limit |
|---|---|---|---|
| GET `/auth/user-groups` | — | 200 `[group]`, by name | 120 / 900s per caller (`USER_GROUP_READ_RATE_LIMIT`) |
| POST `/auth/user-groups` | `name` 1-80, `allTenants?` | 201 `group` | 60 / 900s per caller (`USER_GROUP_WRITE_RATE_LIMIT`) |
| PATCH `/auth/user-groups/:id` | `name?`, `allTenants?` — at least one | 200 `group` | write |
| DELETE `/auth/user-groups/:id` | — | 200 `{id, deleted: true}`; its members go with it | write |
| GET `/auth/user-groups/:id/members` | `page` >=1 (1), `pageSize` 1-100 (50) | 200 `{items:[{memberType, userId, tenantId, label, addedAt}], total, page, pageSize}`, newest first; `label` is a user's `fullName` or a reseller's `slug` — never a phone | read |
| POST `/auth/user-groups/:id/members` | `userIds?`, `tenantIds?` — ≤ 500 each, at least one id | 200 `{added}` — only the new ones; one already in is not an error | write |
| DELETE `/auth/user-groups/:id/members/users/:userId` | — | 200 `{removed: true}` | write |
| DELETE `/auth/user-groups/:id/members/tenants/:tenantId` | — | 200 `{removed: true}` | write |

Every id in a path is `ParseUUIDPipe`d. A user and a reseller have their own
removal path, so neither id can be read as the other.

## Refusals

403 without `user_group.manage` (`PermissionsGuard`), then each as `{reason, message}`:

| reason | status | when |
|---|---|---|
| `group_not_found` | 404 | no such group **in the caller's tenant** — another tenant's id gets this answer |
| `user_not_found` | 404 | no such user, or (to a reseller) another tenant's user |
| `tenant_not_found` | 404 | the platform owner named a reseller that does not exist |
| `member_not_found` | 404 | the removal names no member of this group |
| `platform_only` | 403 | a reseller asked for `allTenants` or named a reseller |
| `not_a_reseller` | 400 | the platform owner named its own tenant as a member |
| `name_taken` | 409 | the tenant already has a group of that name |
| `all_tenants_conflict` | 409 | a reseller named in an every-reseller group, or `allTenants` switched on while resellers are named |
| `group_in_use` | 409 | a discount rule names the group; point the rule elsewhere first |

## Consumers

None on the wire yet: the panel page is a row of its own. Billing's discount
rules name a group by id (`groupId`, billing `contract.purchase.md`).
