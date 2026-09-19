---
id: tenant
layer: domain
status: active
version: 1
updated: 2026-09-19
---

# Contract — tenant / staff seats

A topic file of `contract.md` (§10). A reseller's owner puts people on its team
and takes them off (F-018-j, catalog F-1201, D-42 (2)). Code:
`txnet-backend/tenant-service/src/app/staff/`. What those people may *do* is
their role, which is `identity`'s: [contract.roles.md](../identity/contract.roles.md).

## Membership is not a role

`tenant_staff_member` says **who is on the team, from when, until when**, and
whether they were removed. It holds no permission and no rank. A member's
permissions are their `identity.user.roleId` — a role of that tenant since
F-018-n — which is the role `forward-auth` already puts on their token.

That is D-42 (2) as a table: one RBAC. The column this row dropped
(`roleWithinTenant`, an enum of owner/admin/support/finance_viewer) was a rank
no request could ever read, because the gate reads `user.roleId` and nothing
else. A reseller composes its team's powers at `/api/auth/roles` out of the
platform's global permission keys, and seats people here.

## The routes

| Route | Who | Answer |
|---|---|---|
| `GET /api/tenants/:id/staff` | the reseller's owner, a member with `tenant.manage`, or platform staff with `tenant.manage` | the team, newest invitation first |
| `POST /api/tenants/:id/staff` `{userId, accessExpiresAt?}` | same | `201` the seat, `invited` |
| `POST /api/tenants/:id/staff/accept` | the invited user, themselves | `200` the seat, `active` |
| `DELETE /api/tenants/:id/staff/:memberId` | the owner, a member with `tenant.manage`, or platform staff | `200` the seat, `revoked` |

The seat: `{id, userId, state, invitedByUserId, invitedAt, joinedAt,
accessExpiresAt, revokedAt, user: {id, fullName, username, phoneNumber},
role: {id, name}}`. `role` is the member's `identity` role — shown here because
it is the answer to "what can this person do", and read-only on these routes.

## The four states

| state | the row | admits them? |
|---|---|---|
| `invited` | `joinedAt IS NULL` | no — an invitation is not access |
| `active` | joined, not expired, not revoked | **yes** |
| `expired` | `accessExpiresAt <= now` | no |
| `revoked` | `revokedAt` set | no |

`revoked` wins over the dates: a removed seat is removed whatever its expiry
says. The same reading is what `ResellerAccess` admits on, so the list and the
door can never disagree — one function, `staffState`.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | A seat is granted to a live `active` user **of that reseller's tenant** | this service never writes `identity.user`, as reseller creation does not for an owner. Someone with no account yet needs an emailed invitation and a registration, neither of which this table holds — a row of its own |
| 2 | The reseller's **owner** cannot be seated | they are a user of the platform's tenant (ADR-0059), so they are not found here at all; giving them a role of the tenant they own is the account move ADR-0062 left open |
| 3 | One row per person per reseller (`(tenantId, userId)` unique). Re-inviting a removed member **reuses the row** | the alternative is not a second row but a lost history: who was on this team last month is a question an audit asks |
| 4 | Removing sets `revokedAt`; nothing is deleted | as rules.md #4 for a tenant: the trail outlives the membership |
| 5 | Acceptance is the invitee's own call, on their own session, once | a seat nobody accepted is not access, and `accept` is therefore the one route `ResellerAccess` cannot guard — an unaccepted member is exactly who it refuses |
| 6 | An `accessExpiresAt` in the past is refused (`expiry_past`) | a seat that is expired the moment it is written is a mistake, not a policy |
| 7 | A member reaches reseller self-service only with `tenant.manage`, in a role of that tenant | the seat says they are on the team; the permission says this member administers the reseller. A `Support` role gets a seat and no administration (invariant 21) |

Refusals: `not_allowed` 403 and `reseller_not_found` 404 as
[contract.domains.md](contract.domains.md) (only platform staff learn a
reseller exists), `reseller_suspended` 403, `reseller_terminated` 409,
`user_not_found` 404, `user_inactive` / `already_staff` / `expiry_past` 409,
`staff_not_found` 404, `no_invite` 404.

## Removal is immediate, and it is not a sign-out

A revoked member's token keeps working — their role did not change, and nothing
here touches `identity`. What they lose at once is this reseller: every
`/api/tenants/:id/...` route asks `ResellerAccess`, which reads the seat on the
request. To take their *permissions* away, change or reassign their role
(`/api/auth/roles`), which expires their token by the fingerprint path
(identity invariant 14).

## Who reaches it, and on which pool

`ResellerAccess` (invariant 21): the path's reseller, never the ambient tenant.
A member is the third door it opens, and unlike the owner their session **is**
the reseller's — so their seat is read on the app pool, under RLS. Everything
else here is another tenant's rows (the reseller's seats, the reseller's users),
so it runs on the cross-tenant pool after that refusal (ADR-0053's order).
`accept` is the exception in both respects: no admission, app pool only.

Reading the team is `read` and changing it is `staffWrite`, so a suspended
reseller sees its team and cannot change it ([rules.md](rules.md)); platform
staff can.
