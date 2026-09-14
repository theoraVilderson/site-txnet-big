---
id: entitlement
layer: domain
status: draft
updated: 2026-09-14
---

# Invariants — entitlement

**DRAFT** — from the spec (§4.4–4.6); not enforced in code yet.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Access is answered only by "an active Grant with this feature key exists" — never by a plan name or a role | planned `has active grant` | access sold twice, or given free |
| 2 | Status moves one way; only `suspended → active` returns | planned transition function | an expired Grant revived for free |
| 3 | A Grant's quota changes only by a `quota_adjustment` row, never by editing the Grant's copied quotas | planned service | usage that cannot be reconciled |
| 4 | Quota is on the Grant; every config of a Grant draws on one quota, without double counting | planned (network, F-027) | a family plan billed five times |
| 5 | A Grant is tenant-scoped (RLS) like every other user row (ADR-0024) | planned migration | one tenant reads another's customers |

## How to test

To be written with F-026-b and F-026-e.
