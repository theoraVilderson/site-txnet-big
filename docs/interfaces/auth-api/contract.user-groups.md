---
id: auth-api
layer: interface
status: active
version: 46
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
`{id, name, kind, allTenants, userCount, tenantCount, access:{roleId, roleName, keys}, createdAt, updatedAt}`;
`kind` is `manual`; `access` is what the group gives its user members (v46, AC-1-m).

| Route | Body / query | Answers | Rate limit |
|---|---|---|---|
| GET `/auth/user-groups` | — | 200 `[group]`, by name | 120 / 900s per caller (`USER_GROUP_READ_RATE_LIMIT`) |
| POST `/auth/user-groups` | `name` 1-80, `allTenants?` | 201 `group` | 60 / 900s per caller (`USER_GROUP_WRITE_RATE_LIMIT`) |
| PATCH `/auth/user-groups/:id` | `name?`, `allTenants?` — at least one | 200 `group` | write |
| DELETE `/auth/user-groups/:id` | — | 200 `{id, deleted: true}`; its members go with it | write |
| PUT `/auth/user-groups/:id/access` (v46, AC-1-m) | `{roleId: uuid \| null, keys: [key]}` (≤ 200) — the **whole** set | 200 `group` | write |
| GET `/auth/user-groups/:id/members` | `page` >=1 (1), `pageSize` 1-100 (50) | 200 `{items:[{memberType, userId, tenantId, label, receivesAccess, addedAt}], total, page, pageSize}`, newest first; `label` is a user's `fullName` or a reseller's `slug` — never a phone; `receivesAccess` (v47): a user of the group's own tenant, who holds what it gives | read |
| POST `/auth/user-groups/:id/members` | `userIds?`, `tenantIds?` — ≤ 500 each, at least one id | 200 `{added}` — only the new ones; one already in is not an error | write |
| DELETE `/auth/user-groups/:id/members/users/:userId` | — | 200 `{removed: true}` | write |
| DELETE `/auth/user-groups/:id/members/tenants/:tenantId` | — | 200 `{removed: true}` | write |
| GET `/auth/tenants/:tenantId/user-groups` | — | 200 `[group]` — the **path's** reseller's, behind `ResellerAccess` (invariant 21, `read`), not `user_group.manage`; read in its scope (F-102-g-d, ADR-0064 (1)). 403 `not_allowed` / `reseller_suspended`, 404 `reseller_not_found`, 409 `reseller_terminated` | read |

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
| `group_in_use` | 409 | a discount rule or a gateway's audience names the group; point it elsewhere first |
| `access_on_resellers` | 409 | access on an every-reseller group (v46) |
| `role_not_found` | 404 | the role is neither this tenant's nor a template |
| `key_unknown` | 400 | a key with no `permission` row |
| `key_not_grantable` | 403 | `*` or a `platform.` key, in the keys or the role |
| `key_not_held` | 403 | the caller does not hold a key the group would give — on setting access, and on adding or removing a member of a group that gives it |
| `no_authority` | 403 | a member add or removal on a group that gives access, on someone the caller has no authority over (ADR-0103), themselves included |

## Consumers

panel-web's `/user-groups` page (F-114-m,
[contract.user-groups.md](../panel-web/contract.user-groups.md)). Billing's discount
rules name a group by id (`groupId`, billing `contract.purchase.md`), and so does a
gateway's audience (`billing.gateway_audience`, billing `contract.gateways.md` F-102-g) —
`group_in_use` covers both.
