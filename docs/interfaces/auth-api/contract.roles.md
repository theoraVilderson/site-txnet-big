---
id: auth-api
layer: interface
status: active
version: 25
updated: 2026-09-19
---

# Contract — auth-api / roles

A topic file of [contract.md](contract.md) (§10). The wire shapes of
`/api/auth/roles`, where a tenant administers its own roles (F-018-n,
ADR-0062). Business semantics and every refusal's reason are
[identity/contract.roles.md](../../domains/identity/contract.roles.md); this
file is shapes, codes and limits.

Field schemas live in code, not here:
`txnet-backend/auth-service/src/app/auth/roles/role.schema.ts`.

## Routes

Every route needs a **Bearer** token and the `role.manage` permission, and acts
only on the caller's own tenant. A `role` object is
`{id, name, isTemplate, isSystemRole, permissions[]}`.

| Route | Body / query | Answers | Rate limit | Auth |
|---|---|---|---|---|
| GET  `/auth/roles` | — | 200 `{roles:[role]}` — the caller's tenant's roles, then the system templates (`isTemplate: true`), each with its permission keys | 120 / 900s per caller (route default) | Bearer + `role.manage` |
| POST `/auth/roles` | `name` 2-40, `permissions[]` dotted keys, <=200 (default `[]`) | 201 `{role}`. 400 `role.permissionUnknown` (a key with no `permission` row), 403 `role.permissionNotHeld` (a key the caller does not hold — identity invariant 18), 409 `role.nameTaken` | 60 / 900s **per tenant** (`ROLE_WRITE_RATE_LIMIT`) | Bearer + `role.manage` |
| PATCH `/auth/roles/:id` | `name?` and/or `permissions?` — at least one; `permissions` is the **whole** set | 200 `{role}`. 404 `role.notFound` for a template, another tenant's role and an unknown id alike (identity invariant 9); otherwise as `POST` | 60 / 900s per tenant | Bearer + `role.manage` |
| DELETE `/auth/roles/:id` | — | 200 `{id}`. 404 `role.notFound` as above; 409 `role.inUse` while any user still holds the role | 60 / 900s per tenant | Bearer + `role.manage` |

`:id` is a UUID (`ParseUUIDPipe`) — a malformed id is 400 before any row is read.

## Why the write budget is per tenant

A role is the tenant's, not the caller's, so two admins of one reseller share
one budget and a reseller cannot widen it by adding admins
(`RateLimitBucket.ROLE_WRITE`, C-05). Every write here also wakes the
permission listener, which is platform-wide work
(`identity/invariants.md` #14).

## Not here

No route changes what role a **user** holds — `user.roleId` is written by
register and by staff membership (F-018-j), not by this file. Nor is there a
route that lists the permission vocabulary; a caller composes from the keys its
own `/auth/me` already returns.
