---
id: tenant
layer: domain
status: active
version: 54
updated: 2026-10-09
---

# Contract — tenant / staff seats

A topic file of `contract.md` (§10). A reseller's owner puts people on its team
and takes them off (F-018-j, catalog F-1201, D-42 (2)). Code:
`txnet-backend/tenant-service/src/app/staff/`. What those people may *do* is
their role, which is `identity`'s: [contract.roles.md](../identity/contract.roles.md).

**Being retired (ADR-0139).** Since GR-1-a a seat no longer admits anyone: the
route's key does, from any source, and a person gets keys by being put in a
group. A seat that is not live still **refuses**, because a removed seat kept
its role. GR-1-g moves seated people into groups and drops that check; these
routes then only answer history.

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
| `GET /api/tenants/:id/staff` | the reseller's owner, a member with `staff.manage`, or platform staff with `platform.tenant.manage` | the team, newest invitation first |
| `POST /api/tenants/:id/staff` `{userId, accessExpiresAt?}` | same | `201` the seat, `invited` |
| `POST /api/tenants/:id/staff/accept` | the invited user, themselves | `200` the seat, `active` |
| `PATCH /api/tenants/:id/staff/:memberId` `{accessExpiresAt: date \| null}` | the owner, a member with `staff.manage`, or platform staff | `200` the seat, its end moved or cleared (F-1201-b) |
| `DELETE /api/tenants/:id/staff/:memberId` | the owner, a member with `staff.manage`, or platform staff | `200` the seat, `revoked` |

The role is set after an invite at `PUT /api/auth/tenants/:id/users/:userId/role`
(F-1201-a): this service never writes `identity.user` (rule 1), and calls no other
service. The seat: `{id, userId, state, invitedByUserId, invitedAt, joinedAt,
accessExpiresAt, revokedAt, user: {id, fullName, username, phoneNumber},
role: {id, name}}`. `role` is the member's `identity` role — shown here because
it is the answer to "what can this person do". It is set at
`PUT /api/auth/tenants/:id/users/:userId/role` (F-1201-a, ADR-0134), not here.

## The four states

| state | the row | admits them? |
|---|---|---|
| `invited` | `joinedAt IS NULL` | no — refuses even with the key, until GR-1-g |
| `active` | joined, not expired, not revoked | when they hold the route's key, as without a seat |
| `expired` | `accessExpiresAt <= now` | no — refuses even with the key, until GR-1-g |
| `revoked` | `revokedAt` set | no — refuses even with the key, until GR-1-g |

`revoked` wins over the dates: a removed seat is removed whatever its expiry
says. `ResellerAccess` reads the same three columns (ADR-0139 (2)).

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | A seat is granted to a live `active` user **of that reseller's tenant** | this service never writes `identity.user`, as reseller creation does not for an owner. Someone with no account yet needs an emailed invitation and a registration, neither of which this table holds — a row of its own |
| 2 | The reseller's **owner** cannot be seated, and never will be | they are a user of the platform's tenant (ADR-0059), so they are not found here at all, and they need no seat: `ownerUserId` is their door (invariant 21). The account move is decided, not deferred — ADR-0062 "Consequences", user 2026-09-19 |
| 3 | One row per person per reseller (`(tenantId, userId)` unique). Re-inviting a removed member **reuses the row** | the alternative is not a second row but a lost history: who was on this team last month is a question an audit asks |
| 4 | Removing sets `revokedAt`; nothing is deleted | as rules.md #4 for a tenant: the trail outlives the membership |
| 5 | Acceptance is the invitee's own call, on their own session, once | a seat nobody accepted is not access, and `accept` is therefore the one route `ResellerAccess` cannot guard — an unaccepted member is exactly who it refuses |
| 6 | An `accessExpiresAt` in the past is refused (`expiry_past`) | a seat that is expired the moment it is written is a mistake, not a policy |
| 7 | A member reaches a reseller surface only with **that surface's key**, in a role of that tenant (AC-1-e): `staff.manage` here, `domain.manage` on domains — `shared-core/.../tenant/reseller-keys.ts` | the seat says they are on the team; the key says what this member administers, so a reseller can make "domains only" or "finance only". A `Support` role gets a seat and no administration (invariant 21) |
| 8 | A seat is **not** bounded by `staff_members_max` since GR-1-b: the limit counts people holding a reseller key through the reseller's groups, and a group write is what it refuses (governance `contract.md`, [contract.limits.md](contract.limits.md)) | a seat admits nobody since GR-1-a, so counting seats bounded nothing |
| 9 | A seat's end is moved or cleared in place (`PATCH`), never by re-inviting: acceptance and history stay. A removed seat is `staff_not_found`; a past date `expiry_past`. An **expired** seat given a later end (or none) is a seat again, and a joined member is told (`identity.access.changed`, `seat_restored`) | re-inviting would make them accept again for a date change |
| 10 | Invite, end moved and removal each write an `admin_audit_log` row (`staff_seat_invite` / `_end_set` / `_remove`, target `staff_seat`, values `{userId, accessExpiresAt, revokedAt}`, the caller's IP), and every seat act — acceptance too, with no audit row — writes the holder's `access_history` row through `recordAccessChange` (AC-1-p) | who seated whom, and when it ended, is answered on the person's tab and in the access log |

Refusals: `not_allowed` 403 and `reseller_not_found` 404 as
[contract.domains.md](contract.domains.md) (only platform staff learn a
reseller exists), `reseller_suspended` 403, `reseller_terminated` 409,
`user_not_found` 404, `user_inactive` / `already_staff` / `expiry_past` 409,
`staff_not_found` 404, `no_invite` 404.

## Removal is immediate, and it is not a sign-out

A revoked member's token keeps working — their role did not change, and nothing
here touches `identity`. The removal writes `identity.access.changed`
(`seat_removed`) in its transaction (AC-1-q), so their panel hears it at once. What they lose at once is this reseller: every
`/api/tenants/:id/...` route asks `ResellerAccess`, which reads the seat on the
request. To take their *permissions* away, give them another role
(`PUT /api/auth/tenants/:id/users/:userId/role`). That moves their token
at once (F-101-b).

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
