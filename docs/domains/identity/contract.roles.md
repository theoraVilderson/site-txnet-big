---
id: identity
layer: domain
status: active
version: 30
updated: 2026-10-09
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
| A `platform.` key is refused on every role, `*` included: `role.permissionPlatformOnly` (AC-1-c, invariant 20) | the platform's staff set is never a tenant role's (catalog §3.3, ADR-0135); every role written here is tenant-made, and the gate would refuse the claim anyway |
| A template, another tenant's role and a non-existent id all answer `role.notFound` | one answer, so a write is not an oracle for role ids elsewhere on the platform. It is also what enforces invariant #9 — a write path never finds an `isSystemRole` row |
| `permissions` on an edit is the **whole** set, never a diff | the fingerprint is over a set; a partial edit would race two admins into a half-applied role |
| A role a user still holds is `role.inUse`, not a cascade | `user.roleId` is a NOT NULL FK (invariant #5) and this endpoint has no role it could move those users to on the caller's behalf |

## On a tenant's own path (F-1201-a, ADR-0134)

The same four operations, plus assigning a role to a person, on the **path's**
tenant rather than the caller's. A reseller's owner is a user of the platform's
tenant, so this is the only way they reach their reseller's roles. The door is
`ResellerAccess.runIncludingPlatform`, and `TenantRolesService` delegates role
writes to `RolesService`, so the rules above live once.

| | |
|---|---|
| **What may be granted** | the platform's tenant: the caller's keys, `*` included. A reseller: the **tenant ceiling** — every registry key not `platformOnly` (AC-1-e; it was the keys the templates hold, which made a key grantable only by granting it to every template holder) — whole for its owner, and the part they hold for anyone else |
| **list** | adds `members` (how many of *this* tenant's people hold each role, templates included) and `grantable` (the keys above) |
| **assign** | the role is this tenant's or a template, else `role_not_found`. The writer holds every key of it, else `role_not_held`. `authorityOver` allows the act on this person (ADR-0103), else `no_authority`. Writes `user.roleId` with a `role_change` audit row in the tenant's trail; the same role again writes nothing. The trigger moves the token (F-101-b) |

## The permission registry (AC-1-f, catalog §3.4)

What the role editor shows. The list is `auth-handler/configs/permissions.yaml`,
the file the gate enforces: `tools/permissions-gen.py` generates
`shared-core/.../permission-registry.generated.ts` from it. Each key gets its
`area` (its first segment) and `platformOnly` (held by no role but
`SuperAdmin`, so outside the tenant ceiling). Its texts are the `permissions`
namespace of the backend locale scope: `areas.<area>.label` and
`keys.<key>.{label,description}`. `contracts.py` fails on a stale file or a key
without English or Persian text. A missing text at runtime shows the key.

The registry is what can be *shown*. `identity.permission` rows are still what
can be *granted* (a key with no row is refused). A key in one and not the other
is shown raw, or not offered.

## The reseller keys (AC-1-e, catalog §3.2)

`tenant.manage` was the one key of a reseller's member door, and no tenant-made
role may hold it, so a reseller's role was everything (the owner) or nothing.
It is split: each reseller surface names its own key with
`ResellerAccess.for(key)`, and `RESELLER_KEYS` (`shared-core/.../tenant/reseller-keys.ts`)
lists them — `domain.manage`, `theme.manage`, `bot.manage`, `grant.assign`,
`staff.manage`, `role.manage`, `settings.manage` (currency, time zone,
onboarding), `report.read` (revenue), and the existing `user.read`,
`user.write`, `user.impersonate`, `user_group.manage`, `catalog.manage`,
`gateway.manage`, `campaign.manage`, `restriction.assign`. `wallet.manual_adjust`,
`credential.manage`, `audit.read` and `export.request` are registered and
grantable with no reseller route yet. A subscription, limits and support
consent name no key: they are the owner's contract with the platform.

The keys sit under `Admin` in `permissions.yaml`, which is what puts them in
the ceiling; **no template is granted one** in the database (migration
`20261009000200`), so nobody holds more than before.

## The platform keys (AC-1-c, ADR-0135)

The platform's staff set is the `platform.` namespace —
`platform.tenant.create`, `.tenant.manage`, `.plan.assign`, `.node.manage`,
`.report.read`, `.impersonate` (`shared-core/.../tenant/platform-keys.ts`),
under `SuperAdmin` alone in the policy file. No tenant role may be given one
(above), and `isPlatformStaff` admits a key only for a caller of the platform
owner's tenant, so a reseller's `*` is not the platform's. AC-1-d moved the
platform's routes from `tenant.manage` and `panel.manage` onto them and
retired both keys (migration `20261009000400`).

## Every query is tenant-bound

`role` is policied shared-read, so a query with no `app.tenant_id` bound sees
the templates alone, and an insert is refused by `WITH CHECK`. Every
`RolesService` query therefore runs in `tenantTransaction` (fixed with
F-1201-a: before that, the writes on `/auth/roles` failed on the real database).

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

The reseller **owner's** role, and there will never be one. They are a user of
the platform's tenant who signs in on the reseller's domain as themselves
(ADR-0059), so they hold their platform role and reach the reseller they own
through `ownerUserId` (tenant invariant 21), not through a role of it. Decided
with F-018-j (user, 2026-09-19) and written up in ADR-0062 "Consequences": the
owner is the platform's customer, their wallet and their purchase of the
reseller are the platform tenant's rows, and moving the account would move the
identity and none of them.

Staff membership is `tenant.tenant_staff_member` (F-018-j,
[tenant/contract.staff.md](../tenant/contract.staff.md)): who is on a reseller's
team, from when and until when. It names **no** role — a member's role is their
`user.roleId`, one of these, set by **assign** above — and holds nothing about
permissions itself. That
is D-42 (2): the seat says they are on the team, a role of that tenant says what
they may do, and the reseller keys in it say which of its surfaces they administer.
