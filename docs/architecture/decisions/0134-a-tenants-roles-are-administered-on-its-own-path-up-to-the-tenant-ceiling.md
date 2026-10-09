---
id: adr-0134
status: active
updated: 2026-10-09
---

# ADR 0134 — a tenant's roles are administered on its own path, up to the tenant ceiling

- **Status:** accepted (row F-1201-a; consumers F-1201-b/c/d)
- **Date:** 2026-10-09
- **Affects units:** identity, auth-api, panel-web
- **Decision:** the user's, 2026-10-09 — "the route under the reseller", as recommended

## Context

F-1201-a asked for `PUT /api/auth/users/:userId/role`, acting on the caller's
own tenant, like `/api/auth/roles` (F-018-n). Neither can serve a reseller's
owner. The owner is a user of the platform's tenant (ADR-0059, ADR-0062
"Consequences"), so their own tenant is the platform's. Invariant 18 of the
roles ("grant only what you hold") also leaves them nothing to grant: they hold
customer keys only. As written, nobody could ever put the first role on a
reseller's staff, so the reseller Team and Roles pages (F-1201-c/d) would have
been usable by the platform alone.

## Decision

1. **The tenant is the path's.** `/api/auth/tenants/:tenantId/roles` (list,
   create, edit, delete) and `PUT /api/auth/tenants/:tenantId/users/:userId/role`.
   The door is `ResellerAccess.runIncludingPlatform`, the same one the reseller
   users-admin uses (F-311-a). It admits the owner, a seated member with
   `tenant.manage`, and the platform's staff under the reseller's consent. It
   admits the platform's own tenant to its staff, so one surface serves both
   teams. `/api/auth/roles` stays as it was, for the caller's own tenant.
2. **The tenant ceiling bounds what is granted on a reseller.** The ceiling is
   every concrete key the templates (`role.tenantId IS NULL`) name, `*`
   excepted; SuperAdmin holds nothing else. *Amended 2026-10-09 (AC-1-e, the
   user's choice): the ceiling is the permission registry less its
   platform-only keys — the gate's own ceiling — so a key becomes grantable
   without granting it to every template holder.*
   That is the database's half of the rule `forward-auth` applies to a token
   with `roleScope: tenant`. The owner grants the whole ceiling. A member or
   the platform's staff grant only the part of it they hold. On the platform's
   tenant the rule is invariant 18 unchanged: the caller's own keys, `*`
   included.
3. **Assigning a role asks two questions.** Does the writer hold every key of
   the role (so they cannot hand out what they could not grant), and do they
   have authority over the person (`authorityOver`, ADR-0103)? The write is
   `user.roleId` with a `role_change` audit row in the tenant's trail. The
   trigger moves the token (F-101-b).

## Consequences

- The role list on this path answers `members` per role and `grantable`, the
  keys this caller may tick. The panel draws exactly what the server will
  accept, and a reseller's owner sees the ceiling rather than their own
  customer keys.
- Building this showed that every `RolesService` query ran outside a
  tenant-bound transaction. `role` is policied shared-read, so the writes on
  `/api/auth/roles` were refused by `WITH CHECK` on the real database, and the
  reads saw the templates alone. They now run in `tenantTransaction`.
- The templates and the policy file can drift apart. If they do, the gate
  stays the outer bound and this ceiling the inner one. A key on a template
  that the file's ceiling lacks would be grantable here and refused at the
  gate.

## Alternatives rejected

- **Only the caller's tenant, as the row was written.** Resellers could never
  seat a role-holder, and the routes would have had to be rebuilt as soon as
  one tried.
- **Owner grants nothing, or `*`.** Nothing leaves the feature dead. `*` would
  let an owner mint keys no tenant-made role may hold, such as `tenant.manage`.
