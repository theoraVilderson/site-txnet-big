---
id: panel-web
layer: interface
status: active
version: 34
updated: 2026-09-25
---

# Contract — panel-web: user groups (F-114-m)

A topic file of [contract.md](contract.md) (§10). One page, `/user-groups`
(`PANEL_USER_GROUPS`), under `(panel)/user-groups/`: `UserGroupsView.tsx` the
list, `GroupSheet.tsx` create and rename, `MembersSheet.tsx` one group's
members, `UserSearch.tsx` finding a user, and `_lib/user-groups.ts` the rules.
The routes are auth-api's
[contract.user-groups.md](../auth-api/contract.user-groups.md) (F-114-j); who a
group may hold is governance's
[contract.md](../../domains/governance/contract.md) "User groups".

## Rules

1. **The permission hides it; auth-service scopes it.** The menu entry
   `requires: ["user_group.manage"]` and names no tenant type: a reseller has
   groups of its own. What is listed is the session's tenant's groups.
2. **Resellers are the platform owner's only, decided by the tenant type.**
   `canNameResellers` is `tenant.type === "platform_owner"`, never `*` — a
   reseller administers its own roles. For anyone else the page shows no
   resellers column, no "every reseller" box and no reseller ids, and the
   bodies never carry `allTenants` or `tenantIds` (`platform_only` is not a
   state a reseller can reach from here).
3. **One sentence per refusal.** `REFUSAL_KEYS` is a `Record` over
   `UserGroupRefusal`; the spec reads `UserGroupRejection` from the service.
4. **The form mirrors the schema:** a name of 1..80 once trimmed; an edit
   sends only what changed, and nothing at all when nothing did — the schema
   refuses an empty patch.
5. **Finding a user goes through the caller's own door, not the group
   routes** (`memberSearchOf`): the platform owner with `user.search` searches
   `GET /auth/users`; a reseller's owner, or a seat holding `tenant.manage`,
   searches its own `GET /auth/tenants/:own/users` (`ResellerAccess`). Anyone
   else types ids. Typed ids are split on spaces, commas or lines, each kept
   once; one that is not a uuid is named and nothing is sent; more than 500 of
   either kind is refused before the call.
6. **A reseller is picked from the list** (`tenantApi.resellers`, first 100)
   when the caller holds `tenant.manage`, else typed as an id. A group of every
   reseller offers no reseller field and says so.
7. **Nothing is patched from an answer.** Every add, remove, rename and delete
   re-reads the members page and the list (the counts). `added` is shown as
   the service counts it — only the new members.
8. **Delete is confirmed**, and the sentence says the members go with it; a
   group a discount rule serves answers `group_in_use`, shown as its sentence.

## Proof

`user-groups/user-groups.test.ts` — the refusal union against the service
source, the permission key and the schema bounds against the service, the menu
entry for the platform owner and a reseller and hidden without the key,
`canNameResellers` by tenant type, `memberSearchOf` per caller, the form
(`validateGroupForm`, `createGroupBody`, `updateGroupBody`), `parseIds`,
`membersBody`, every key in `en` and `fa`.
