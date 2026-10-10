---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-10
---

# Contract — panel-web: groups (F-114-m, GR-1-f)

A topic file of [contract.md](contract.md) (§10). The panel's one place to
give access (ADR-0139 (1)): a tenant's groups, each with members — each
membership with an end — and the keys ticked on the group. Under
`(panel)/groups/`: `GroupsView.tsx` the list, `GroupWizard.tsx` create (GR-1-h),
`GroupSheet.tsx` rename, `MembersSheet.tsx` one group's members and their end, edited as a draft (GR-1-j), `AccessSheet.tsx`
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
5. **One box, one row per account** (`UserSearch`, GR-1-m): through the
   caller's own door (`memberSearchOf`): the platform owner with
   `user.search` searches `GET /auth/users`; a reseller's owner, or someone
   holding `user.read`, its own `GET /auth/tenants/:own/users`; on a tenant's
   path, that tenant's. A reseller is never offered as a second row: it is
   its owner's account (user, 2026-10-10 — "it is one account"; nothing reads
   a reseller member, GR-1-n). Anyone with no search door types user ids —
   split on spaces, commas or lines, each once; a non-uuid is named; more
   than 500 is refused first.
6. **Members change as a draft** (`MembersDraft`, user 2026-10-10): a pick is
   a *new* row, a removal marks its row (and undoes), an end day is set per
   person on its row; someone already in or pending is never added twice
   (`draftAdd`), adding back a marked member unmarks them, an end equal to
   the saved one is no change (`draftEnd`). An end — a person's or a reseller's (GR-1-l) — is a date and a time to
   the minute, in the visitor's zone (`DatePicker withTime`, `wallTimeOf`,
   `instantOf`, GR-1-k). The footer counts the changes.
7. **Save is one request** (`changesBody`, `POST …/members/changes`, GR-1-i):
   every change or none; a refusal shows its sentence, marks the row
   `facts.detail` names, and keeps the draft to fix. Discard empties it;
   closing with changes unsaved asks first.
8. **Nothing is patched from an answer.** A save re-reads the members page
   and the list.
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
11. **A new group is made in a wizard** (GR-1-h): start, name, access, review.
    The start is a **preset** from `GET /auth/permissions` (`presets`) or *from
    scratch*. A preset only fills the form: its name, if not typed yet, and its
    keys narrowed by `presetDraft` to what this caller may give on this group.
    The keys it leaves out are named in a warning. `every` (admin) is every
    offered key the caller may give, never `platform.` or `self.`. On the
    platform's own group a preset's `platformKeys` join its keys (GR-1-s:
    Support ticks `platform.support`, ADR-0141); a reseller's never sees them. Submit is
    `create`, then `setAccess` when keys are ticked. A refused second write
    keeps the group, and the next submit sends only the access. The finished
    screen offers to add members (opens `MembersSheet`).

## Proof

`groups/groups.test.ts` — the refusal union against the service source, the
permission key and schema bounds, the menus (groups present; no team, roles or
old address), `canNameResellers` and `isPlatformGroup` by tenant type and
scope, `memberSearchOf`, the form bodies, `parseIds`, `membersBody` with an
end, `endBody`, the members draft (`draftAdd`, `draftToggleRemove`,
`draftEnd`, `changesBody`), `accessBody` (the whole set, the fold, the 200-key cap),
`groupKeyAreas`, `receivers`, `presetDraft` (held, offered, admin), `groupsApiPath`, every old address redirecting,
no *team* or *role* in the page's `en` and `fa` strings, and every key in both.
