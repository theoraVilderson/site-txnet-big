---
id: identity
layer: domain
status: active
version: 32
updated: 2026-10-09
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
| **Keys** | the role's keys, plus every group's role keys and extra keys, plus the keys given to the person, **minus the keys taken from them**. A removal wins over every source, the role included (user, 2026-10-08) |
| **Personal** | true when anything beyond the role applies: a key given or taken, or a membership of a group that gives access. Everyone else's answer is exactly their role's |
| **`*`** | the role's alone. A `*` role is neither widened nor narrowed; `*` from any other source is dropped |

## Where it is read

| Reader | How |
|---|---|
| A token mint (sign-in, refresh, switch, impersonation) | `AccessReader.ofLoaded(user)`, then `TokenService` mints `permissions` = the keys, `permHash` = their fingerprint, `personal: true` when personal |
| The Redis writer (`PermissionNotificationsListener`) | `AccessReader.ofIds` for each person a notification reaches; writes `user:<id>:permissions` for a personal person, **deletes** it otherwise |
| The gate and `AuthGuard` | the token, compared against the person's key when present, the role's key when not (ADR-0138 (4)) |
| Impersonation's authority check | both people's answers (AC-1-k); block, role assignment and the users list follow with AC-1-l |

A mint site that passes no answer gets the role's keys. For a personal person
that token is refused at once as stale, so a missed site costs one refresh and
never grants more.

## What recomputes whom

| Change | Recomputed |
|---|---|
| a role's keys | the role's key, then its **personal** holders — directly or through a group (`AccessReader.personalPeople(roleId)`) |
| a person's role | `user:<id>:role` and that person's key |
| `{kind:"person"}` | that person's key |
| `{kind:"all"}` / every connect | every role, then every personal person |

Holders who are not personal cost nothing: the role's key already describes
them.
