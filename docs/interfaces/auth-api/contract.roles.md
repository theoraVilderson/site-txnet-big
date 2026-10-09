---
id: auth-api
layer: interface
status: active
version: 45
updated: 2026-10-09
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

## On a tenant's own path (v42, F-1201-a, ADR-0134)

`/auth/tenants/:tenantId/...`, the tenant is the path's. Bearer, **no**
`role.manage` guard: `ResellerAccess.for('role.manage')` is the door (owner, seated member with
`role.manage` (AC-1-e), platform staff under the reseller's consent; the platform's
tenant to its staff). Its refusals answer as on
[contract.reseller-users.md](contract.reseller-users.md), with `{reason}`.
Role-level refusals are the ones above, unchanged. Code:
`.../roles/tenant-roles.controller.ts`.

| Route | Body | Answers | Rate limit |
|---|---|---|---|
| GET `/auth/tenants/:tenantId/roles` | — | 200 `{roles:[role + members], grantable:[key]}` | `RESELLER_USER_READ` per caller |
| POST `/auth/tenants/:tenantId/roles` | as `POST /auth/roles` | as `POST /auth/roles`; a key past `grantable` is 403 `role.permissionNotHeld` | `ROLE_WRITE` per **path** tenant |
| PATCH `/auth/tenants/:tenantId/roles/:id` | as `PATCH /auth/roles/:id` | as `PATCH /auth/roles/:id` | same |
| DELETE `/auth/tenants/:tenantId/roles/:id` | — | as `DELETE /auth/roles/:id` | same |
| PUT `/auth/tenants/:tenantId/users/:userId/role` | `{roleId}` (UUID) | 200 `{userId, role:{id, name}}`. 404 `role_not_found` / `user_not_found`, 403 `role_not_held` / `no_authority` | `RESELLER_USER_WRITE` per caller |
| GET `/auth/tenants/:tenantId/users/:userId/keys` (v45, AC-1-l) | — | 200 `{userId, keys, role:{id,name,keys}, groups:[{id,name,keys}] (v47), given:[{key,reason,by,at}], taken:[…]}`. 404 `user_not_found` | `RESELLER_USER_READ` per caller |
| PUT `/auth/tenants/:tenantId/users/:userId/keys/:key` (v45) | `{effect: "give"\|"take", reason}` (3-500) | 200 the view above. 400 `key_unknown`; 403 `key_not_grantable` / `key_not_held` / `no_authority`; 404 `user_not_found`; 409 `key_on_wildcard` | `RESELLER_USER_WRITE` per caller |
| DELETE `/auth/tenants/:tenantId/users/:userId/keys/:key` (v45) | — | 200 the view above. 404 `key_not_found`; otherwise as `PUT` | same |

## Why the write budget is per tenant

A role is the tenant's, not the caller's, so two admins of one reseller share
one budget and a reseller cannot widen it by adding admins
(`RateLimitBucket.ROLE_WRITE`, C-05). Every write here also wakes the
permission listener, which is platform-wide work
(`identity/invariants.md` #14).

## Not here

## The permission registry (v43, AC-1-f)

| Route | Answers | Auth |
|---|---|---|
| GET `/auth/permissions` | 200 `{areas:[{area, label, permissions:[{key, label, description, platformOnly}]}]}`, texts in the request's language (`Accept-Language`) | Bearer, any caller — the vocabulary is not a secret |

What a caller may tick is `grantable` on a tenant's path; on `/auth/roles`, the
keys its own `/auth/me` returns. Code: `.../permissions/permission-registry.controller.ts`.
Semantics: [identity/contract.roles.md](../../domains/identity/contract.roles.md).
