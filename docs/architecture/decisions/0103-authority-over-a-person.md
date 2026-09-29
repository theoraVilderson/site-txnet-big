---
id: adr-0103
status: accepted
updated: 2026-09-29
---

# ADR 0103 — authority over a person: one rule for every act on another account

- **Status:** accepted
- **Date:** 2026-09-29 (user, D-56; row F-311-ac)
- **Affects units:** identity, tenant, panel-web
- **Amended by:** [ADR-0104](0104-platform-staff-see-a-resellers-people-only-with-its-consent.md) — platform staff reach a reseller's people only with its consent
- **Builds on:** ADR-0062 (4) (grant only what you hold), ADR-0102 (the
  platform's own tenant on the users-admin routes)

## Context

A tenant's staff are users of that tenant, so every surface over "users"
includes its admins. After ADR-0102 a platform staffer can block a peer or the
platform's owner from the users page, and a reseller's member can block
another member; `cannot_block_self` is the only guard. Blocking is today the
one act on another person's account, but more are coming — assigning a role,
resetting a password, ending someone's sessions, deleting an account,
impersonation (`user.impersonate` already exists as a key). A guard written
per act drifts; one gets missed.

Rejected: **"admins are untouchable"** (two tiers only; no one could stop a
rogue admin, and every custom role a reseller builds lands in one tier — it
would be rebuilt the day role assignment ships); **a numeric rank per role**
(someone must rank every role every tenant creates; a rank enum was already
removed once because nothing read it — `tenant/contract.staff.md`).

## Decision

1. **One rule, one place.** Every act on another person's account asks
   `authority over a person` first — the way every reseller-named route asks
   `ResellerAccess` (tenant invariant 21). It becomes an identity invariant.
2. **The rule**, first match wins:
   1. the target is the actor — refused;
   2. the target is the tenant's `ownerUserId` — refused, to everyone;
   3. the actor is that tenant's owner, or platform staff acting in a
      reseller's tenant — allowed (authority from structure);
   4. otherwise, among peers of one tenant: allowed only if the actor holds
      **every** permission the target holds **and at least one more**
      (`holdsPermission`, so `*` covers every key).
3. **What is compared.** The actor's permissions from their claims (fresh by
   the role fingerprint); the target's read at the act from their role, never
   from a cached view. A customer holds no keys, so any admitted admin acts on
   them.
4. **Refusal** is 403 with its own reason and i18n key, distinct from the
   door's `not_allowed`: the caller was admitted to the tenant and lacks
   authority over this one person.
5. **The panel is told, not left to guess.** The users list returns
   `canAct` per row, computed by the same rule; staff are listed with a
   staff mark, not hidden — hiding protects nothing, the server does.

## Consequences

- Custom roles and new permission keys fall into the order with no upkeep.
- Two peers (two `Admin`s, two `SuperAdmin`s) cannot lock each other out;
  a rogue peer is stopped by someone above them, ultimately the owner.
- Every future account act (role assignment, password reset, session kill,
  delete, impersonation) must call the rule; its row cites this ADR.
- Acting on a person's **services** (Grants, configs) is not an act on their
  account and stays outside this rule.
