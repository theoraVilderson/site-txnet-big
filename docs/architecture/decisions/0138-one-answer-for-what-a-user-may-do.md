---
id: adr-0138
status: active
updated: 2026-10-09
---

# ADR 0138 — One answer for what a user may do

- **Status:** accepted (AC-1-k; AC-1-l and AC-1-m build on it)
- **Date:** 2026-10-09
- **Affects units:** identity, governance, forward-auth, auth-api, redis-keyspace
- **Decision:** the user's (AC-1-k's note: "removal wins", 2026-10-08); the
  storage and gate shape the agent's, judged for the long run
- **Amends:** ADR-0043 §1–3 (what `permHash` fingerprints, what the gate reads)

## Context

Until now a person's keys were their role's keys, so ADR-0043 could fingerprint
a **role**: one `role:<id>:permissions` key, compared against every token of
every holder. AC-1-l (a key given to or taken from one person) and AC-1-m (a
group holding a role and/or keys) make two people of one role hold different
sets. A per-role fingerprint cannot see either.

Three facts shape the answer.

- **Role edits reach many people.** The `user` template is held by every
  customer of every tenant. A fingerprint written per user for *everyone* would
  turn one template edit into a write per customer on the platform.
- **The gate checks a system role by name** against `permissions.yaml`
  (ADR-0037). A `Support` holder given `coupon.manage` would fail that check on
  every call, not just the coupon ones.
- **`*` is not a list.** SuperAdmin minus `user.write` has no spelling.

## Decision

1. **One function answers.** `accessOf` (`identity`) returns the keys a person
   holds: their role's keys, plus each group's role keys and extra keys, plus
   the keys given to them, **minus the keys taken from them — a removal wins
   over every source**, the role included. `TokenService` mints `permissions`
   from it, so the gate, `AuthGuard`, `PermissionsGuard`, `me` and the authority
   rule (ADR-0103) all read this one answer.
2. **A person is *personal* when anything beyond their role applies to them**: a
   key given or taken, or a membership of a group that holds access. Everyone
   else's answer is exactly their role's.
3. **`permHash` fingerprints the person's answer.** For a non-personal person
   that is byte-for-byte the role's fingerprint, so tokens minted before this
   stay valid and the role key keeps working for them.
4. **Redis adds `user:<userId>:permissions`, written only for personal people**
   and deleted when they stop being personal. The gate and `AuthGuard` read it
   beside the two ADR-0043 keys, in the same round trip. **When it is present
   it decides alone. When it is absent, the role key decides, as before.** Deleting
   rather than overwriting is what makes leaving safe: a token that still carries
   the extra keys no longer matches the role's fingerprint, so it is refused. A
   missing key still refuses nobody (ADR-0043 §3).
5. **The writer is still Postgres.** Triggers on the new rows notify the
   existing channel with `{kind:'person', userId}` or `{kind:'group', groupId}`.
   A role edit recomputes the role key and then **only the personal holders** of
   that role, directly or through a group. A person's role change recomputes
   that person. Boot recomputes every role and every personal person. The cost
   of a template edit stays one write per role plus one per personal holder.
6. **The gate's ceiling.** A token carries `personal: true` when its holder is
   personal. For such a token, a key outside the role's `permissions.yaml` entry
   is accepted only if it is in the tenant ceiling (the same ceiling a tenant's
   own role is held to, F-018-n2). A non-personal token is checked exactly as
   before. So the policy file still bounds every grant, and no write in the
   database can reach a `platform.` key or `*`.
7. **What can be given.** Only a key that exists, is not `*`, is not a
   `platform.` key, and is held by the giver. A role holding `*` is not narrowed
   or widened: personal sources are ignored for its holders, and the write paths
   refuse them. A group's access reaches **only user members of the group's own
   tenant**. A platform group that holds another tenant's user, or resellers
   (`allTenants`), gives those members nothing, because the platform's keys are
   not a reseller's.

## Consequences

- One more Redis key per *personal* person, and none for everyone else. The gate
  reads four keys instead of three, in the same `MGET`.
- A role edit now does work proportional to its personal holders. Holders that
  are not personal cost nothing new.
- `access.changed` (AC-1-q) gains the causes `key_given`, `key_taken`,
  `key_lifted`, `group_access` and `group_membership`. The page re-reads as before.
- Not chosen: **a per-user fingerprint for everyone** (the row's literal shape).
  It is simpler to read but costs one write per customer per template edit, and
  the gap between that and (4) only grows with tenants. **A second claim listing
  only the extra keys** was also rejected. It would split the one answer back
  into two, and every reader would have to merge them the same way.
- A query that finds holders of a key by role rows alone (the engagement wheel
  report) does not see personal grants. That is acceptable while such queries
  pick report recipients, not who may act. A new one that decides access must
  ask `accessOf`.
