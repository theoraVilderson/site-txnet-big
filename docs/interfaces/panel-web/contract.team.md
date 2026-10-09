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
| Roles (F-1201-d) | `myResellerRolesPath(id, self)` — `/my-resellers/:id/roles`, `/reseller/roles` on its own domain | `RESELLER_MENU` `reseller-roles`, after users; for platform staff and a seated admin, `people` › roles on the session's tenant (`tenant.manage`, as users) |

No permission is judged on either page: `ResellerAccess` admits, and its
refusal (or the consent platform staff need, F-117-g) is the page's sentence.

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
