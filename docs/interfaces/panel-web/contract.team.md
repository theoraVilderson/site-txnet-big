---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-09
---

# Contract — panel-web / a tenant's roles and team

A topic file of [contract.md](contract.md) (§10). The two pages a tenant's
administrators use to say who is on the team and what each may do (catalog
F-1201). Both are on the **path's** tenant, never the session's: a reseller's
for its owner and its seated admins, the platform's for its staff (ADR-0134).
Server rules: [identity/contract.roles.md](../../domains/identity/contract.roles.md),
[tenant/contract.staff.md](../../domains/tenant/contract.staff.md).

## Where they are

| Page | Route (C-10) | In the menu |
|---|---|---|
| Team (F-1201-c) | `myResellerTeamPath(id, self)` — `/my-resellers/:id/team`, `/reseller/team`; the session's own: `/team` (`PANEL_TEAM`, `OwnTenantView`) | `RESELLER_MENU` `reseller-team`, after users; `people` › team, as roles |
| Roles (F-1201-d) | `myResellerRolesPath(id, self)` — `/my-resellers/:id/roles`, `/reseller/roles` on its own domain; the session's own: `/roles` (`PANEL_ROLES`) | `RESELLER_MENU` `reseller-roles`, after users; for platform staff and a seated admin, `people` › roles on the session's tenant (`tenant.manage`, as users) |

No permission is judged on either page: `ResellerAccess` admits, and its
refusal (or the consent platform staff need, F-117-g) is the page's sentence.

## Team (F-1201-c)

`TeamView` over `resellerStaffApi` (`lib/tenant-api.ts`) and `tenantRolesApi`.

| # | Rule | Why |
|---|---|---|
| 1 | **A reseller's team is its seats** (`GET /tenants/:id/staff`): name, role, state and end. A removed seat is not shown | the seat is what admits a member (tenant invariant 21); its row stays for the audit, not for this list |
| 2 | **The platform's team is the people holding a staff role** (`/auth/tenants/:id/users?staff=true`, one page of 100). No seat, no end, no state | the platform has no seats, and its door never reads one. An end shown here would not be enforced — a row of its own if wanted |
| 3 | Add: search this tenant's users (3+ characters), pick one. On a reseller, invite (end optional), **then** set the chosen role at auth. If that second call is refused, the seat stands and the page says why. On the platform, a role is required and is the whole act | tenant-service never writes a user and calls no other service (tenant contract.staff.md rule 1); an unaccepted seat grants nothing, so the two calls need not be atomic |
| 4 | A role is offered only when the caller may grant every key on it (`grantable`). Who they may give it to is auth's call; `role_not_held`, `no_authority` and the seat refusals each have a sentence (`_lib/team.ts`) | identity invariant 18 and ADR-0103 decide on the server; the page only avoids offering what will be refused |
| 5 | The end is moved or cleared in place (`PATCH`), as the end of that day in the visitor's zone | F-1201-b; re-inviting would make them accept again |
| 6 | Remove asks first. A reseller seat is revoked and **their role stays**. A platform staffer gets the template with no permission | a role is the tenant's to change on purpose. Taking someone off the platform's team is giving them back the ordinary user's role |

Test: `my-resellers/team.test.tsx`.

## Roles (F-1201-d)

`RolesView` over `tenantRolesApi` (`site-pwa/src/lib/auth-api.ts`).

| # | Rule | Why |
|---|---|---|
| 1 | The tenant's own roles are listed with `members` (how many of its people hold each) and their keys as labels. The templates follow, read-only, with nothing to edit or delete | a template belongs to no tenant (identity invariant 9); offering an edit would only earn `role.notFound` |
| 2 | The editor offers exactly `grantable`, from the same answer (`*` = every key): grouped by the registry's areas, each key with its label and description (`GET /auth/permissions`, AC-1-f). A platform-only key is marked | the panel never guesses a ceiling. A reseller's owner holds no operator key, so `/auth/me` would offer them nothing (ADR-0134) |
| 3 | A key the role holds that this caller may not grant is shown checked and locked. A key the registry does not name is shown raw under "other" | an edit sends the whole set (never a diff), so nothing the role has may silently drop out of it |
| 4 | Delete is off, with the reason, while `members > 0`. Otherwise it is confirmed first | the server answers `role.inUse`; a role is freed by giving its holders another one on the Team page |
| 5 | A save re-reads the list | `members` and `grantable` are the server's |

Helpers: `my-resellers/_lib/roles.ts` (`permissionIndex`, `editorAreas`,
`unknownKeys`). Test: `my-resellers/roles.test.tsx`.
