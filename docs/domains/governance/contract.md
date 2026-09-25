---
id: governance
layer: domain
status: active
version: 2
updated: 2026-09-25
---

# Contract — governance

**User groups are built** (F-114-j, below). Settings, temporal grants and
restrictions are still **schema only** — no service implements them; their
rows are intent derived from `txnet-backend/prisma/domains/governance.prisma`.

## TL;DR

User groups — a named set of a tenant's users, the one target discount rules,
campaigns and restrictions share (built). Low-traffic key/value config for users, plus two opposite tools: `temporal_access_grant` (extra access, one-time or recurring-daily window, in a timezone) and `user_restriction` (a cap: max daily traffic, max active configs, max daily spend, ...).

## Provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| manage user groups — **built** (F-114-j) | `user_group.manage`; name (≤ 80, unique in the tenant), `allTenants` | the caller's tenant's group, audited | sync | `name_taken`, `platform_only`, `all_tenants_conflict`, `group_in_use` |
| manage a group's members — **built** | user ids and/or reseller ids (≤ 500 each per call) | added (idempotent) or removed, audited | sync | `user_not_found`, `tenant_not_found`, `not_a_reseller`, `platform_only`, `member_not_found` |
| is this person / this reseller in group G — **built** | a member list, a user id or a tenant id | `admitsUser` / `admitsTenant` (`user-group.ts`) | sync | — |
| get/set user setting (intended) | userId, key, JSON value | row | sync | — |
| grant temporal access | grantee, permissionKey, mode, window | `temporal_access_grant` | sync | overlapping active grant |
| assign restriction | userId, restrictionKey, limit JSON, scope | `user_restriction` | sync | — |
| evaluate effective access | userId, permissionKey, now | allow/deny (role ∪ active grants, minus hard blocks) | sync | — |

## User groups (F-114-j)

Code: `txnet-backend/auth-service/src/app/governance/user-groups/` — served by
auth-service, beside the users it groups. Wire shapes:
[auth-api/contract.user-groups.md](../../interfaces/auth-api/contract.user-groups.md).

| Rule | Held by |
|---|---|
| A group and every member row of it are one tenant's (strict RLS); the platform owner's groups are its own tenant's rows | RLS on both tables; every query in the caller's `tenantTransaction` |
| A reseller's group holds only its own users. Only the platform owner's may hold another tenant's user, a reseller (`memberType: tenant`), or every reseller (`allTenants`) | `memberRefusal` / `groupRefusal`; trigger `governance.user_group_scope_ok()`; the permission is **not** the boundary — a reseller administers its own roles |
| Another tenant's user reads as `user_not_found` to a reseller — the answer RLS gives; the platform owner's lookups past its tenant run on the cross-tenant pool only after the `platform_owner` check | `UserGroupAdminService.addMembers` |
| A reseller member is the reseller, not its customers: `admitsUser` answers for a person, `admitsTenant` for a reseller; "every reseller" never admits the platform itself | `user-group.ts` |
| `allTenants` and named resellers exclude each other | `all_tenants_conflict` on add and on switching it on |
| Membership is `manual` (`kind`); a computed kind is a new `UserGroupKind`, and consumers ask `admitsUser` / `admitsTenant`, never the rows' shape | schema; `user-group.ts` |
| A group a discount rule names is not deleted (`group_in_use`); deleting one removes its members | `discount_rule` FK RESTRICT; member FK CASCADE |
| Every write leaves an `admin_audit_log` row, target `user_group`: `user_group_create` / `_update` / `_delete` / `_member_add` / `_member_remove` | `UserGroupAdminService.audit` |

Consumers: billing's discount rules (`groupId`, user members only — billing
`contract.purchase.md`). Campaigns and restrictions will target groups; neither does yet.

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`; base role/permissions to combine with grants; a group's user member, its `tenantId` and `fullName` | access evaluation falls back to base role only; a user member cannot be added |
| tenant | `tenant.tenantType` — whether the caller is the platform owner; a reseller member's id and `slug` | no group may reach past its tenant |

## Guarantees (intended)

- Grants and restrictions are time-bounded; an expired row has no effect.
- `timezone` defaults to `Asia/Tehran`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
