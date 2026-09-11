---
id: adr-0037
status: accepted
updated: 2026-09-11
---

# ADR 0037 — The gateway keys policy by role name, carried in the token

- **Status:** accepted
- **Date:** 2026-09-11
- **Affects units:** forward-auth, identity

## Context

`auth-handler` enforces `configs/permissions.yaml` on every gated request: a
token claiming a permission its role is not granted is refused 403. The engine
looked the role up by `claims.RoleID`. `TokenService` signs `roleId` as
`user.roleId`, the `identity.role` foreign key — a UUID minted by the seed,
different on every database. The file is keyed by role *name*. The lookup
missed for every real token, and an unknown role is denied, so **every
authenticated request through `my-auth` was answered 403**. Verified live on
2026-09-11: a UUID `roleId` got 403, `roleId: "admin"` got 200. Found by F-085;
unnoticed because only `billing-service`, a scaffold, carries `my-auth`.

The file and the seed also disagreed on spelling: the seed creates `user`,
`Support`, `Admin`, `SuperAdmin`; the file declared `admin`, `support`, `user`.

## Decision

1. The access token (and the impersonated token) carries **`roleName`** —
   `identity.role.name` — beside `roleId`. Tokens with no role loaded (OTP,
   reset) sign `''`.
2. The policy engine keys on `roleName`, **matched exactly**. `role.name` is
   unique case-sensitively, so folding case could merge two distinct roles.
3. `permissions.yaml` is keyed by the names exactly as `prisma/seed.js` spells
   them. `SuperAdmin` gets an entry, a superset of `Admin`.
4. `tools/contracts.py` fails when a seeded role has no entry in the file.
5. `roleId` and the `X-Role-Id` header are unchanged. No new header: nothing
   downstream asks for the name.

## Consequences

- A token minted before this change has no `roleName` and is refused 403 by
  the policy until it is refreshed — at most one access TTL. Acceptable while
  nothing real sits behind `my-auth`.
- A role created at runtime (the schema allows dynamic RBAC) is refused at the
  gateway until it gets a row in the file. That is the file doing its job —
  defence in depth is an allow-list — but it means a new role is a deploy, not
  a database insert. Revisit when roles become tenant-editable.
- Renaming a role is now a contract change across the seed, the file and
  `ImpersonationService`'s rank map; `tools/contracts.py` catches the first two.

## Alternatives considered

- **Key the file by role id.** Ids are per-database UUIDs; a checked-in file
  cannot address them, and every environment would need its own copy.
- **Drop the file.** Removes the 403, and the defence in depth with it: the
  gateway would then trust any permission a validly signed token claims.
- **Fold case on both sides.** Hides the seed/file disagreement instead of
  fixing it, and conflates names the database treats as distinct.
