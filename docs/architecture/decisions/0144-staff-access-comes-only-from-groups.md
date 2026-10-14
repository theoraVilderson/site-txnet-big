---
id: adr-0144
status: active
updated: 2026-10-14
---

# ADR 0144 — Staff access comes only from groups

- **Status:** accepted (built by GR-1-v)
- **Date:** 2026-10-14
- **Decision:** the user's (2026-10-14, row GR-1-v)
- **Affects units:** identity, forward-auth, governance
- **Builds on:** ADR-0138 (one answer for what a user may do), ADR-0139 (one
  word: group). **Amends:** ADR-0037 (the gate keys its policy by role name),
  F-018-n2 (the tenant ceiling is the union of the non-`*` roles)

## Context

GR-1-g moved every seated holder of a staff role onto a group, but the `Admin`
and `Support` system templates stayed. Nobody is meant to hold them, yet the
seed still makes them, and the gate's policy file still says what each may
claim. Worse, the file builds the **tenant ceiling** (what any group or
tenant-made role may give) from the `Admin` and `Support` entries. So staff
access had two sources, role and group, and every new rule (ADR-0141's
consent, ADR-0143's audience) had to hold both. The impersonation rank by role
name is already gone (AC-1-h: `authorityOver` compares keys).

## Decision

1. **Two system roles remain: `user`** (every account's base) **and
   `SuperAdmin`** (the platform owner's `*`, which no group may give,
   ADR-0138 (7)). `Admin` and `Support` are deleted.
2. **The tenant ceiling is its own list.** `permissions.yaml` gains a
   `grantable:` section: every key a group or tenant-made role may give. The
   gate's ceiling is that list plus the non-`*` roles (`user`). A key is added
   there, never under a role, and a role's name no longer widens anything.
3. **Nobody loses a key.** One migration turns whoever still holds either role
   into a member of a group of their own tenant with the role's keys (GR-1-g's
   way), copies the keys of a group whose `roleId` names one onto the group,
   puts the people on `user`, and only then deletes the two roles.
4. The registry's `platformOnly` stays "listed under `SuperAdmin` and nowhere
   else", so the `platform.` set is unchanged.

## Consequences

- Positive: one source of staff access. A rule about staff reads groups and
  keys; nothing reads a role name but the gate's `user`/`SuperAdmin` lookup.
- Accepted cost: the policy file's shape changes, so the Go parser and the two
  tools that share it (`contracts.py`, `permissions-gen.py`) change together.
- Forecloses: a system template with staff keys. A preset (GR-1-h) is the
  starting point instead, and it creates a group.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep the two templates, unused | the ceiling would still hang off their entries, and the next rule would again have to hold both sources |
| Rename the `Admin` entry to a pseudo-role holding the ceiling | the gate would accept a token whose role carried that name; a list that is not a role should not sit among roles |

## Revisit trigger

A need for a second base role besides `user` (e.g. a separate kind of account).
