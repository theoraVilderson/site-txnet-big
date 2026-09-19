---
id: adr-0062
status: accepted
updated: 2026-09-19
---

# ADR 0062 — A role belongs to a tenant, or to no one

- **Status:** accepted 2026-09-19 with F-018-n (D-42 (2), user 2026-09-17); the owner's account question closed with F-018-j (user, 2026-09-19)
- **Date:** 2026-09-19
- **Affects units:** identity, tenant, forward-auth
- **Amends:** `identity/data-model.md` ("role — tenant-scoped? no"),
  `identity/invariants.md` #9

## Context

`identity.role` was global: one `name`, unique across the platform, and every
tenant's users drew from the same handful of rows. That was true while the
platform had one tenant. A reseller needs its own `Support`, its own
`Accountant`, granting the subset of the platform it chooses — and two
resellers must be able to spell those names the same way without seeing each
other's.

D-42 (2) already chose **one RBAC, not two**: a reseller's staff hold an
`identity.Role` of that reseller, and `tenant_staff_member` (F-018-j) holds
membership only. This ADR is how that shape is built, and what it must not
break on the way.

What it must not break is the token path. An access token carries `roleId` and
`permHash`; `forward-auth` refuses a token once Redis holds a different
fingerprint for that `roleId` (ADR-0043, F-101-a/b). That path keys a role by
**id**, never by name and never by tenant, which is what makes this change
cheap: nothing in it has to learn about tenants.

## Decision

1. **`role.tenantId` is nullable. Null means a system template** — a role every
   tenant reads and none may edit. Non-null means the row belongs to that
   tenant, which is the only one that may read it as its own, edit it or
   delete it. The existing rows (`user`, `Admin`, `SuperAdmin`) are left null:
   a shared definition with no owner is exactly what they already were.

2. **Not a second table.** `tenant_role` beside `role` would fork the three
   things the token path depends on — one `roleId` on a token, one fingerprint
   per role, one `role_permission` relation for `permissionFingerprint` to run
   over (invariant #14). One nullable column forks none of them.

3. **Permission keys stay global.** A key names a capability of the platform,
   so a reseller *composes* keys, it does not invent them. A key with no
   `permission` row is refused rather than stored: a typo must not become a
   grant that silently means nothing.

4. **A caller grants only what it holds.** The keys admitted onto a role are
   the keys on the writer's own token; `*` may grant any key that exists.
   Without this rule `role.manage` alone would be the whole platform — a
   reseller writes the grants of the roles its own staff hold, so it could mint
   `tenant.manage` for itself and then read every tenant. This is the same
   reasoning `UserSearchService` states for not treating `user.search` as a
   boundary (F-018-ad).

5. **`role` is not in `TENANT_SCOPED_MODELS`.** The ambient scope (ADR-0024)
   would hide exactly the rows that must stay visible — a template belongs to
   no tenant. The scope is applied in `RolesService` instead, in one shape: a
   read is `{OR: [own, template]}`, a write is the caller's own tenant and
   nothing else.

6. **A template and another tenant's role answer alike.** Both are
   `role.notFound` on a write, so the endpoint is not an oracle for whether a
   role id exists elsewhere on the platform. This is also what now enforces
   invariant #9: a template is never found by a write path, so an
   `isSystemRole` row cannot be deleted through the API.

## Consequences

- The fingerprint + Redis path is untouched, and that is the point: the trigger
  still notifies on `role_permission`, the listener still recomputes by id, and
  a role edited by a reseller expires its staff's tokens within one
  notification. `RolesService` writes no Redis key — invariant #14 stands.
- **The table becomes policied**, shape B of `20260909001500` (shared-read):
  read is `NULL OR mine`, write is strict, so the database says what (1) says.
  The cost is one move — `PermissionNotificationsListener` recomputes across
  tenants from a `LISTEN` callback with no ambient tenant, so it reads on
  `CrossTenantPrismaService` now. `rls-coverage.spec.ts` is what turned this
  up, in the same session the column was added; without it the gap would have
  been a silently empty recompute.
- Uniqueness costs two indexes, not one. `(tenantId, name)` leaves the
  templates free to collide, because NULLs are distinct in Postgres, so a
  partial unique index over `name WHERE "tenantId" IS NULL` carries what the
  old global `@unique` meant.
- A role still held by a user cannot be deleted. `user.roleId` is a NOT NULL FK
  (invariant #5) and there is no role the endpoint could reassign those users
  to on the caller's behalf, so it refuses with `role.inUse`.
- **Decided with F-018-j (user, 2026-09-19): the owner's account never moves.**
  A reseller's owner holds their platform role, is a user of the platform's
  tenant, and reaches the reseller they own through `ownerUserId` in
  `ResellerAccess` (tenant invariant 21) — never through a role of that tenant.
  This was left open here to be answered by F-018-j, and the answer is "no",
  not "later". Three reasons, in order of weight:
  1. **The money.** The owner is the platform's customer: their wallet, their
     purchase of the reseller (F-019-h, charged to that wallet) and their
     payment history are rows of the platform's tenant. Moving `user.tenantId`
     moves the identity and none of those rows, leaving one person's money in
     one tenant and their account in another — which ADR-0006 and tenant
     invariant 2 do not allow.
  2. **ADR-0059 (3)-(7) exist because the owner is elsewhere.** The password
     fallback, OTP and recovery, account switching and the Mini App, the bot
     door and the 60s hand-across code are all consequences of the owner being
     a user of another tenant. Removing the cause does not remove those seven
     decisions; it rewrites them.
  3. **Ownership is a relationship, not a role.** With more resellers per
     person, and reseller tiers (F-901's `resellerPath`), "which tenant is this
     person in" stops having one answer. `ownerUserId` + `ResellerAccess`
     scales to many; a `user.tenantId` column does not.

  What this costs, stated plainly: the owner's authority over their reseller is
  not expressible in RBAC, so a rule like "this owner may not terminate their
  own subscription" would be a capability list on the owner door, not a role.
  That is a small, local change if it is ever wanted.

- **Still open, and a different question:** `tenant.ownerUserId` is one column,
  so a reseller has exactly one owner. Two people sharing a reseller, or a
  reseller owned by a reseller (F-901), has no representation — and the
  work-around of a staff seat with `tenant.manage` only reaches someone who has
  an account *inside* that reseller, which a co-owning platform customer does
  not. Deliberately not built with F-018-j: a backlog row of its own, to be
  designed when co-ownership or F-901 is actually wanted (user, 2026-09-19).
