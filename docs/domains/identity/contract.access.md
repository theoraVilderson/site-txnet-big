---
id: identity
layer: domain
status: active
version: 34
updated: 2026-10-13
---

# Contract — what a person may do

A topic file of [contract.md](contract.md) (§10). The one answer every reader
of a person's keys asks (AC-1-k, ADR-0138): the token, the gate, `AuthGuard`,
`me` and the authority rule (ADR-0103). Roles themselves are
[contract.roles.md](contract.roles.md).

Code: `auth-service/src/app/auth/permissions/access.ts` (`accessOf`, pure) and
`access.reader.ts` (`AccessReader`, the reads).

## The answer

| | |
|---|---|
| **Keys** | the role's keys, plus every group's role keys and extra keys (a membership that has ended counts for nothing), plus the keys given to the person, **minus the keys taken from them**. A removal wins over every source, the role included (user, 2026-10-08) |
| **Personal** | true when anything beyond the role applies: a key given or taken, or a membership of a group that gives access. Everyone else's answer is exactly their role's |
| **`platform.` keys** | from a group only for a person of the platform owner's tenant (GR-1-e, ADR-0139 (4)); dropped for anyone else, whatever the group holds. Such a personal answer carries `platformTenant` |
| **`*`** | the role's alone. A `*` role is neither widened nor narrowed; `*` from any other source is dropped |

## Where it is read

| Reader | How |
|---|---|
| A token mint (sign-in, refresh, switch, impersonation) | `AccessReader.ofLoaded(user)`, then `TokenService` mints `permissions` = the keys, `permHash` = their fingerprint, `personal: true` when personal, `platformTenant: true` when also of the platform owner's tenant (the gate's only way to know, forward-auth v5) |
| The Redis writer (`PermissionNotificationsListener`) | `AccessReader.ofIds` for each person a notification reaches; writes `user:<id>:permissions` for a personal person, **deletes** it otherwise |
| The gate and `AuthGuard` | the token, compared against the person's key when present, the role's key when not (ADR-0138 (4)) |
| The authority rule (ADR-0103) | the target's whole answer, read on the writer's transaction: impersonation, role assignment, block, profile edit, a key write, and the users list's `canAct` (AC-1-l) |

A mint site that passes no answer gets the role's keys. For a personal person
that token is refused at once as stale, so a missed site costs one refresh and
never grants more.

## What recomputes whom

| Change | Recomputed |
|---|---|
| a role's keys | the role's key, then its **personal** holders — directly or through a group (`AccessReader.personalPeople(roleId)`) |
| a person's role | `user:<id>:role` and that person's key |
| `{kind:"person"}` | that person's key — a key written on them, they joined or left a group (AC-1-m), or their membership's end moved (ADR-0139 (3)) |
| `{kind:"group"}` | every user member of the group (`AccessReader.membersOf`): its role or keys changed |
| `{kind:"all"}` / every connect | every role, then every personal person |

Holders who are not personal cost nothing: the role's key already describes
them.

## Giving or taking one key (AC-1-l)

On a tenant's own path, through the role door (`ResellerAccess.for('role.manage')`,
as **assign** in [contract.roles.md](contract.roles.md)). Code: `TenantRolesService`.

| Operation | Input | Output | Refuses |
|---|---|---|---|
| read a person's keys | userId | `{userId, keys, role:{id,name,keys}, groups:[{id,name,keys}], given:[{key,reason,by,at}], taken:[…]}` — `groups` by `AccessReader.groupsOf`, the rule the answer counts by | `user_not_found` |
| give or take | userId, key, `{effect: give\|take, reason, startsAt?, endsAt?}` | the same view, after | `window_on_take`, `window_past`, `window_inverted` (F-030-a, below), `key_not_grantable` (`*`, `platform.`), `key_unknown` (no `permission` row), `key_not_held` (outside the writer's grant scope), `key_on_wildcard` (the person holds `*`), `no_authority`, `user_not_found` |
| lift | userId, key | the same view, after | `key_not_found` (nothing given or taken), and the checks above |

One row per person and key (`identity.user_permission`): a give replaces a
take of the same key and the reverse. The same effect and reason again writes
nothing. Each write is one `user_permission_set` / `user_permission_lift` audit
row in the tenant's trail (`newValue`/`oldValue` `{key, effect, reason}`) and one
`access.changed` with cause `keys_set`, whose `given`/`taken` are what the
person's answer gained and lost — a gift of a key the role already gives moves
nothing and tells no one. The trigger moves the token; nothing here touches Redis.

A key given to someone makes them staff on the users list (`staff`), as a role
holding keys does.

### A key given for a window (F-030-a)

| Rule | Held by |
|---|---|
| A give may name `startsAt` and/or `endsAt`; it counts from its start (none: at once) until its end (none: until lifted) — wherever the answer is read (`AccessReader`, `findKeyHolders`), through shared-core `liveKeyWindow` | `key-window.spec.ts` |
| A take has no window (`window_on_take`); an end not after now is `window_past`, an end not after the start `window_inverted`; a start not in the future is stored as none. The window is part of the act: the same key, effect, reason and window again writes nothing | `user-keys.view.ts` |
| At its start `KeyWindowSweep` marks the row `openedAt`, at its end removes it — each a write, so the trigger moves the token — and tells each person whose answer moved: `access.changed`, cause `key_window`, `given`/`taken` against their answer just before; history actor the giver, no audit row. Clock: worker `key_window` (`always_on`) over `POST /api/internal/user-keys/windows`; safe twice | `key-window.sweep.ts` |
| Daily windows (hours in a time zone) are not built until asked | — |
