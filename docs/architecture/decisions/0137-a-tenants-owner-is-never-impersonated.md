---
id: adr-0137
status: active
updated: 2026-10-09
---

# ADR 0137 — a tenant's owner is never impersonated

- **Status:** accepted (follows AC-1-h)
- **Date:** 2026-10-09
- **Affects units:** identity, panel-web
- **Decision:** the agent's, at the user's request ("decide it properly, for the long run"), 2026-10-09

## Context

AC-1-h moved impersonation onto `authorityOver` (ADR-0103). Its rule 2,
"never the tenant's owner, to anyone", now also refuses the platform's staff,
who before could impersonate a reseller's owner under an `act` consent or an
emergency entry. That was a side effect, so it needed a decision of its own.

What it rests on:
- a consent is granted by the owner **or** by a staff seat holding
  `tenant.manage` (ADR-0104 (4)); `grantedByUserId` records which;
- an impersonated token reaches only the user's own panel (ADR-0136), and
  AC-1-h left opening staff pages under impersonation as a later decision.

## Decision

1. **The owner of a tenant is never impersonated: not by its own staff, not by
   the platform under consent, not under an emergency entry.** It is the
   tenant's SuperAdmin, and §3.6 already puts SuperAdmin out of reach. The
   platform's own tenant follows the same rule.
2. **Support reaches an owner's problem through tier B, in its own name.**
   Under an `act` consent, the platform's staff work in the reseller through
   the staff door. Every act is then recorded as theirs, not as the owner's.
3. **No consent option will open it.** An "include my own account" checkbox
   was considered and rejected (below).
4. The panel (AC-1-i) does not offer "sign in as this user" on an owner, so
   the 403 is never the first thing anyone sees.

## Why, over the long run

- **Accountability for the strongest account.** An act made by impersonating
  the owner is recorded against the owner. On the account that can revoke
  consent, change gateways and assign roles, the trail must name the person
  who really acted.
- **It stays safe as impersonation grows.** Today an impersonated owner
  reaches only a personal panel. Once staff pages are opened under
  impersonation (the decision AC-1-h left open), impersonating an owner would
  hand over the whole reseller. Closing it now means that later decision
  cannot widen it by accident.
- **A staff seat cannot hand over its owner.** Consent can be granted by a
  `tenant.manage` seat. If consent opened the owner, a member could expose
  their owner's account without the owner knowing.
- **It holds with reseller tiers.** If resellers ever have sub-resellers, each
  tenant still has one owner, and the rule needs no new case.

## Rejected

- **Allow it under consent (lift rule 2 for staff).** Cheapest, but the
  staff-seat problem above and a trail that names the wrong person.
- **An "include my own account" option only the owner may tick.** Closes the
  staff-seat problem, but not the accountability one. It also adds a
  scope, a column and an interface to the consent that tier B makes
  unnecessary.

## Consequences

- `reseller-impersonation.spec.ts` pins it on the platform path, under consent
  and under emergency alike.
- Lifting it needs a new ADR, not a change of the rule.
