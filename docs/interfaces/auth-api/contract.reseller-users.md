---
id: auth-api
layer: interface
status: active
version: 37
updated: 2026-09-29
---

# Contract — auth-api / a named reseller's users

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. The wire shapes of `/api/auth/tenants/:tenantId/users`, where
a reseller reads and blocks its own users (F-311-a, ADR-0064). Business
semantics — what a block means, why `banned` outranks it, what is deliberately
absent — are
[identity/contract.reseller-users.md](../../domains/identity/contract.reseller-users.md);
this file is shapes, codes and limits.

Field schemas live in code:
`txnet-backend/auth-service/src/app/auth/users/reseller-users.schema.ts`.

## Routes

Every route needs a **Bearer** token and **no permission**: the door is
`ResellerAccess` (tenant invariant 21) — the reseller's owner, one of its staff
seats holding `tenant.manage`, or the platform owner's staff — judged against
the **reseller the path names**, never the session's tenant. The path may
also name the **platform's own tenant**, admitted to platform staff only
(F-311-aa, ADR-0102); anyone else asking for it gets `not_allowed`. A `user` object is
`{id, fullName, username, phoneMasked, status, createdAt, canAct, staff}` and carries no phone
number and no email. `canAct` is whether the caller may block or unblock this
person (ADR-0103); `staff` marks one who holds any permission, or the owner.

| Route | Body / query | Answers | Rate limit | Auth |
|---|---|---|---|---|
| GET `/auth/tenants/:tenantId/users` | `q?` 3-64, `page` >=1 (1), `pageSize` 1-100 (20) | 200 `{items:[user], total, page, pageSize}`, newest first. Admitted under `read`, so a suspended reseller still sees its customers | 60 / 900s per caller (`RESELLER_USER_READ_RATE_LIMIT`) | Bearer + `ResellerAccess` |
| POST `/auth/tenants/:tenantId/users/:userId/block` | — | 200 `user` at `suspended`, every session of that account revoked. Blocking an already-blocked user is the same 200 and writes nothing | 20 / 900s per caller (`RESELLER_USER_WRITE_RATE_LIMIT`) | Bearer + `ResellerAccess` (`staffWrite`) |
| DELETE `/auth/tenants/:tenantId/users/:userId/block` | — | 200 `user` at `active`. **Unblock is the deletion of the block**, not a second verb on the user | 20 / 900s per caller (shared with `POST`) | Bearer + `ResellerAccess` (`staffWrite`) |

Both ids are `ParseUUIDPipe`d, so a malformed one is a 400 before any door runs.

## Refusals

`ResellerAccess`'s four, and this surface's four, each as `{reason}`:

| reason | status | when |
|---|---|---|
| `not_allowed` | 403 | not the owner, not a seat with `tenant.manage`, not platform staff — and, to everyone but platform staff, an unknown reseller |
| `reseller_not_found` | 404 | platform staff only: there is no such reseller |
| `reseller_suspended` | 403 | the reseller's status closes the capability the route named |
| `reseller_terminated` | 409 | closed to everyone, staff included |
| `user_not_found` | 404 | no such user **in that reseller's scope** — another tenant's id gets this answer, not a 403 |
| `user_banned` | 409 | the platform banned this account; a reseller neither deepens nor lifts that |
| `cannot_block_self` | 400 | the caller is the user named |
| `no_authority` | 403 | admitted to the tenant, but not over this person: they are its owner, or hold every key the caller holds (ADR-0103) |

## Consumers

`bot-app` (F-311-c) is the first, and the reason this is data-only. The panel's
`/my-resellers/:id/users` (F-311-v, panel-web `contract.reseller-users.md`) reads the list, and blocks / unblocks from it (F-311-v4).
