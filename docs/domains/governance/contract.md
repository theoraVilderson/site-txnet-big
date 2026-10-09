---
id: governance
layer: domain
status: active
version: 4
updated: 2026-10-05
---

# Contract — governance

**User groups are built** (F-114-j, below), and so are display preferences
(UX-1-k, below) — the first keys of `user_setting`. Other settings, temporal
grants and restrictions are still **schema only** — no service implements them; their
rows are intent derived from `txnet-backend/prisma/domains/governance.prisma`.

## TL;DR

User groups — a named set of a tenant's users, the one target discount rules,
campaigns and restrictions share (built). Low-traffic key/value config for users, plus two opposite tools: `temporal_access_grant` (extra access, one-time or recurring-daily window, in a timezone) and `user_restriction` (a cap: max daily traffic, max active configs, max daily spend, ...).

## Provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| manage user groups — **built** (F-114-j) | `user_group.manage`; name (≤ 80, unique in the tenant), `allTenants` | the caller's tenant's group, audited | sync | `name_taken`, `platform_only`, `all_tenants_conflict`, `group_in_use` |
| manage a group's members — **built** | user ids and/or reseller ids (≤ 500 each per call), an end (`expiresAt`, GR-1-d) | added (idempotent), end moved, or removed, audited | sync | `user_not_found`, `tenant_not_found`, `not_a_reseller`, `platform_only`, `member_not_found`, `expiry_past` |
| is this person / this reseller in group G — **built** | a member list, a user id or a tenant id | `admitsUser` / `admitsTenant` (`user-group.ts`) | sync | — |
| read / write the caller's display preferences — **built** (UX-1-k) | the token's user; any subset of `ui.motion`, `ui.dashboard`, `ui.pins`, `ui.sidebar` | every key, defaults filled in | sync | `unknown_preference`, `invalid_preference`, `preference_too_large` |
| get/set any other user setting (intended) | userId, key, JSON value | row | sync | — |
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
| Every write leaves an `admin_audit_log` row, target `user_group`: `user_group_create` / `_update` / `_delete` / `_member_add` / `_member_remove` / `_member_end_set` | `UserGroupAdminService.audit` |
| A membership's end is set on add and moved or cleared in place, never in the past (`expiry_past`); moving it is a grant like joining (`mayMove`, the staff limit, `group_access` told when the answer moved) (GR-1-d, ADR-0139 (3)) | `addMembers` / `setMemberEnd` (`member-end.spec.ts`) |
| A reseller's groups are reached by its path too (ADR-0139 (5)): every write, through `ResellerAccess.for('user_group.manage')`, in its scope — the owner gives the whole tenant ceiling, the platform's staff the part they hold, its member their own keys | `ResellerUserGroupsController` (`reseller-user-groups.spec.ts`) |

Consumers: billing's discount rules (`groupId`, user members only — billing
`contract.purchase.md`). Campaigns and restrictions will target groups; neither does yet.

## A group holds access (AC-1-m, ADR-0138)

A group may give its user members a role (`user_group.roleId`) and/or extra
keys (`user_group_permission`); they hold them while members, as part of
their answer (identity `contract.access.md`). Set by
`PUT /auth/user-groups/:id/access` with the **whole** `{roleId, keys}`.

| Rule | Held by |
|---|---|
| Only the group's **own tenant's** user members hold it. A platform group's reseller customer, or a reseller member, gets nothing | `AccessReader` counts a membership only when the person's tenant is the group's |
| Not on "every reseller" (`allTenants`): `access_on_resellers` | `setAccess` |
| The role is this tenant's or a template (`role_not_found`); no `*`, and no `platform.` key but on the platform's own group (GR-1-e, ADR-0139 (4)), in the role or the keys (`key_not_grantable`); every key exists (`key_unknown`) and the writer holds it (`key_not_held`) | `setAccess` |
| Joining or leaving a group that gives access is a grant: the writer holds every key it gives (`key_not_held`) and has authority over the person (ADR-0103, `no_authority` — yourself included) | `UserGroupAdminService.mayMove` |
| A role a group gives is `role.inUse` to a delete | FK RESTRICT; `RolesService.remove` |
| Every member whose answer moved is told: `access.changed`, cause `group_access`, with the keys gained and lost — on access set, member add or remove, and group delete. `user_group_access_set` is audited with the set before and after | `UserGroupAdminService.tell` |
| A reseller's staff are bounded (GR-1-b, ADR-0139): a member add to, or access set on, a group giving a reseller key (`reseller-keys.ts`) that raises the count of people holding one through its groups past `staff_members_max` is 409 `reseller_limit_reached`, `facts {key, limit, used}`, rolled back; under the per-reseller lock; the platform's staff and the platform's own tenant pass | `UserGroupAdminService.withinStaffLimit`, `RESELLER_LIMIT_USAGE.staff_members_max` (`staff-limit.spec.ts`) |
| A membership's end is kept (GR-1-c, ADR-0139 (3)): past it, a sweep removes the row — the trigger moves the token — and tells each person whose answer moved (`access.changed`, cause `group_membership_ended`, `group` + `given`/`taken` against the answer just before the end), history actor = who added them, no audit row; at most 500 per run, safe twice | `MembershipEndSweep` (`membership-end.spec.ts`) on worker `group_membership_end` |
| Tokens move after commit by trigger: `{kind:"group"}` on the role or keys, `{kind:"person"}` on a user member added or removed | migration `20261009000600` |

## Display preferences (UX-1-k)

Code: `txnet-backend/auth-service/src/app/governance/ui-preferences/`. Wire
shapes: [auth-api/contract.ui-preferences.md](../../interfaces/auth-api/contract.ui-preferences.md);
what each key means: [panel-web/contract.ux.md](../../interfaces/panel-web/contract.ux.md) P1–P4.

| Rule | Held by |
|---|---|
| One `user_setting` row per key, category `display`; the keys and their schemas are owned here (`UI_PREFERENCE_SCHEMAS`) | `ui-preferences.ts` |
| Only the caller's own rows: `user_setting` has no tenant column and no RLS, so the `userId = sub` filter is the whole boundary | `UiPreferencesService` |
| A stored value off its current schema reads as the default — a narrower schema needs no migration | `readUiPreferences` |

## Emits (events)

`identity.access.changed` (AC-1-q's outbox row, cause `group_access`, or
`group_membership_ended` from the end sweep, GR-1-c), in the
group write's own transaction with each moved member's `access_history` row, both by
shared-core `recordAccessChange` against the act's audit row (AC-1-p); consumed as
identity's are. Postgres `NOTIFY identity_permissions_changed` from the triggers above.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId`; base role/permissions to combine with grants; a group's user member, its `tenantId` and `fullName` | access evaluation falls back to base role only; a user member cannot be added |
| tenant | `tenant.tenantType` — whether the caller is the platform owner; a reseller member's id and `slug`; `staff_members_max` in effect (`resellerLimitOf`, GR-1-b) | no group may reach past its tenant; a staff-making write is refused rather than unbounded |

## Guarantees (intended)

- Grants and restrictions are time-bounded; an expired row has no effect.
- `timezone` defaults to `Asia/Tehran`.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |
