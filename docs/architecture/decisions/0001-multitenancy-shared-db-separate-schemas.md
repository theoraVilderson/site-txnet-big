---
id: adr-0001
status: accepted
updated: 2026-09-04
---

# ADR 0001 — Shared database, separate Postgres schemas for multitenancy

- **Status:** accepted
- **Date:** 2026-09-04 (documented; decision predates this doc, taken in the
  merged architecture spec the Prisma files are generated from)
- **Affects units:** all domains

## Context

One platform, many resellers. Options ranged from a schema/DB per tenant to a
single shared set of tables with a `tenantId` column. Per-tenant databases do not
scale operationally for a long tail of small resellers; fully shared tables make
cross-tenant leakage a single missing `WHERE` away.

## Decision

We will use **one Postgres database with `multiSchema`**, one schema per business
domain (`identity`, `tenant`, `billing`, ...), and a `tenantId` column on every
tenant-scoped row. Exactly one `Tenant` row is `platform_owner`. Structural
isolation (Row-Level Security, partial unique indexes, multi-column CHECK
constraints, native partitioning) is authored as manual migration SQL because
Prisma cannot express it.

## Consequences

- Positive: one migration path, cross-domain queries possible, cheap to add a
  tenant.
- Negative / accepted cost: isolation depends on discipline + the manual SQL
  actually being applied. **As of now that SQL is not applied** — see
  `security/threat-model.md`.
- Forecloses: per-tenant physical backup/restore and per-tenant Postgres tuning.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Database per tenant | operational cost for many small tenants |
| Single flat schema (no `multiSchema`) | domain boundaries invisible; naming collisions |
| App-level tenant filter only, no schemas | no defence in depth |

## Revisit trigger

A tenant with regulatory data-residency requirements, or > ~5k active tenants
making shared-table hotspots painful.
