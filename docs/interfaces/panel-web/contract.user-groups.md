---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-09
---

# Contract — panel-web: groups (F-114-m, GR-1-f)

A topic file of [contract.md](contract.md) (§10). The panel's one place to
give access (ADR-0139 (1)): a tenant's groups, each with members — each
membership with an end — and the keys ticked on the group. Under
`(panel)/groups/`: `GroupsView.tsx` the list, `GroupSheet.tsx` create and
rename, `MembersSheet.tsx` one group's members and their end, `AccessSheet.tsx`
what it gives, `UserSearch.tsx` finding a user, and `_lib/user-groups.ts` the
rules. The routes are auth-api's
[contract.user-groups.md](../auth-api/contract.user-groups.md) (F-114-j,
GR-1-d); who a group may hold and what it may give is governance's
[contract.md](../../domains/governance/contract.md) "User groups".

## Where it is

| Address (C-10) | Whose groups | In the menu |
|---|---|---|
| `/groups` (`PANEL_GROUPS`) | the session's own, over `/auth/user-groups` | `people` › groups, `requires: ["user_group.manage"]`, no tenant type |
| `/my-resellers/:id/groups`, `/reseller/groups` on its own domain (`myResellerGroupsPath`) | the path's tenant, over `/auth/tenants/:id/user-groups` (`ResellerAccess`, ADR-0139 (5)) | `RESELLER_MENU` `reseller-groups`, key `user_group.manage` |

`/team`, `/roles`, `/user-groups`, `/my-resellers/:id/team|roles` and
`/reseller/team|roles` redirect to the matching groups page: the Team and Roles
pages (F-1201-c/d) are gone, and their menu entries with them. The page says
*group* only — never *team* or *role* (ADR-0139 (1)).

## Rules

1. **Whose groups is the page's scope** (`GroupsScope`, `groupsApi(tenantId)`):
   every sheet reads it, so none writes to another tenant's groups. On the own
   page the permission hides it; on a path the door admits and its refusal is
   the page's sentence.
2. **Resellers are the platform owner's own groups' only**, decided by the
   tenant type and the scope (`canNameResellers(me, tenantId)`), never `*`. For
   any other group the page shows no resellers column, no "every reseller" box
   and no reseller ids, and the bodies never carry `allTenants` or `tenantIds`.
3. **One sentence per refusal.** `REFUSAL_KEYS` is a `Record` over
   `UserGroupRefusal`; the spec reads `UserGroupRejection` from the service.
4. **The form mirrors the schema:** a name of 1..80 once trimmed; an edit
   sends only what changed, and nothing at all when nothing did.
5. **Finding a user goes through the caller's own door** (`memberSearchOf`):
   the platform owner with `user.search` searches `GET /auth/users`; a
   reseller's owner, or someone holding `user.read`, its own
   `GET /auth/tenants/:own/users`; on a tenant's path, that tenant's. Anyone
   else types ids — split on spaces, commas or lines, each once; a non-uuid is
   named and nothing is sent; more than 500 of either kind is refused first.
6. **A reseller is picked from the list** (`tenantApi.resellers`, first 100)
   on the platform, else typed as an id.
7. **A membership may end** (GR-1-c): an add carries one optional end day for
   everyone it brings in (`membersBody`, that day's last moment in the
   visitor's zone); someone already in keeps theirs. Each user's end is shown,
   and moved or cleared in place (`endBody`, `PATCH …/members/users/:userId`).
8. **Nothing is patched from an answer.** Every add, remove, end move, rename
   and delete re-reads the members page and the list.
9. **Delete is confirmed**, and says the members go with it; `group_in_use`
   is shown as its sentence.
10. **A group's access is keys ticked on it** (`AccessSheet`), never a role
    picked. The `KeyPicker` offers what the tenant's key door says this caller
    may give (`grantable`); a `platform.` key only on the platform's own group
    (`groupKeyAreas`, `isPlatformGroup`, GR-1-e). A role an older group was
    given shows as its keys, ticked, and is folded into them on the first save
    (`accessBody` sends `roleId: null` and the **whole** set; nothing when
    untouched). Who receives them: the members the server marks
    `receivesAccess`. A group of every reseller gets a sentence, no form.

## Proof

`groups/groups.test.ts` — the refusal union against the service source, the
permission key and schema bounds, the menus (groups present; no team, roles or
old address), `canNameResellers` and `isPlatformGroup` by tenant type and
scope, `memberSearchOf`, the form bodies, `parseIds`, `membersBody` with an
end, `endBody`, `accessBody` (the whole set, the fold, the 200-key cap),
`groupKeyAreas`, `receivers`, `groupsApiPath`, every old address redirecting,
no *team* or *role* in the page's `en` and `fa` strings, and every key in both.
