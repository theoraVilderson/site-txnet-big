---
id: identity
layer: domain
status: active
version: 22
updated: 2026-09-19
---

# Contract — roles and permissions

A topic file of [contract.md](contract.md) (§10). What a role is now that it
can belong to a tenant (F-018-n, ADR-0062, D-42 (2)), and the four operations a
tenant administers its own roles with. The token claims a role ends up on, and
the fingerprint that expires them, stay in `contract.md`; nothing about either
changed here — both key a role by `id`.

Code: `auth-service/src/app/auth/roles/`. Schema:
`prisma/domains/identity.prisma`, migration `20260919000200_identity_role_tenant`.

## What a role is

| | |
|---|---|
| **A tenant's role** | `role.tenantId` = that tenant. Its own name, its own grants; only that tenant reads it as its own, edits it or deletes it |
| **A system template** | `role.tenantId IS NULL`. Every tenant reads it, none may edit it. The rows that existed before F-018-n (`user`, `Admin`, `SuperAdmin`, ...) are these |
| **A name** | unique per tenant, so two resellers may both have a `Support`. The templates share one namespace of their own (a partial unique index — `data-model.md`) |
| **A permission key** | global, and never invented here. `identity.permission` is the whole vocabulary; a role is a subset of it |

## Operations

Every one needs `role.manage` **and** runs in the caller's own tenant. The
permission is the door; the tenant on the caller's claims is the boundary.

| Operation | Input | Output | Sync? | Refuses |
|---|---|---|---|---|
| list roles | the caller's session | the caller's tenant's roles **and** the system templates: `{id, name, isTemplate, isSystemRole, permissions[]}` | sync | — |
| create a role | `name` (2-40), `permissions[]` (dotted keys, <=200, default none) | the role as above, stamped with the caller's tenant | sync tx | `role.nameTaken`; `role.permissionUnknown`; `role.permissionNotHeld` |
| edit a role | its id, `name?` and/or `permissions?` — at least one | the role | sync tx | `role.notFound`; the two permission keys above |
| delete a role | its id | `{id}` | sync tx | `role.notFound`; `role.inUse` while any user holds it |

## The rules behind those refusals

| Rule | Why |
|---|---|
| A caller may grant only the keys **it holds itself**; `*` (SuperAdmin) may grant any key that exists | a tenant writes the grants of the roles its own staff hold, so without this `role.manage` alone would let a reseller mint `tenant.manage` for itself. ADR-0062 (4) |
| A key with no `permission` row is refused for everyone, `*` included | a typo must not become a grant that silently means nothing |
| A template, another tenant's role and a non-existent id all answer `role.notFound` | one answer, so a write is not an oracle for role ids elsewhere on the platform. It is also what enforces invariant #9 — a write path never finds an `isSystemRole` row |
| `permissions` on an edit is the **whole** set, never a diff | the fingerprint is over a set; a partial edit would race two admins into a half-applied role |
| A role a user still holds is `role.inUse`, not a cascade | `user.roleId` is a NOT NULL FK (invariant #5) and this endpoint has no role it could move those users to on the caller's behalf |

## What did not change

`role_permission` is still the one relation `permissionFingerprint` runs over,
and the Postgres trigger is still the only writer of `role:<id>:permissions`
(invariant #14, ADR-0043). `RolesService` writes rows and no Redis key: one
transaction per change, so a replaced grant set wakes the listener once —
Postgres folds identical notifications inside a transaction. A reseller editing
a role therefore expires its staff's tokens by the same path an SQL migration
does, and `forward-auth` learned nothing new.

One thing did move. `identity.role` is now policied (shared-read), and the
listener recomputes every tenant's roles from a `LISTEN` callback that has no
ambient tenant — so it reads through `CrossTenantPrismaService` instead of the
app pool, which would show it the templates alone. A policy, not a bypass:
`data-model.md`.

## Not here

The reseller **owner's** role. They are a user of the platform's tenant who
signs in on the reseller's domain as themselves (ADR-0059), so they hold their
platform role, not a role of the tenant they own — F-018-c's note still stands.
Moving an owner's account into the tenant it owns is a decision of its own; see
ADR-0062 "Consequences" and F-018-j.

Staff membership is `tenant.tenant_staff_member` (F-018-j,
[tenant/contract.staff.md](../tenant/contract.staff.md)): who is on a reseller's
team, from when and until when. It names **no** role — a member's role is their
`user.roleId`, one of these — and holds nothing about permissions itself. That
is D-42 (2): the seat says they are on the team, a role of that tenant says what
they may do, and `tenant.manage` in it is what administers the reseller.
