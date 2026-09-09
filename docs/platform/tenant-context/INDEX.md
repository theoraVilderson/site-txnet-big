---
id: tenant-context
layer: platform
status: active
version: 6
keywords: [tenant context, isolation harness, measure isolation, isolation test, prove isolation, RLS test, tenant leak test, ambient tenant, withTenant, tenant scoping, cross-tenant, cross-tenant pool, second connection pool, tenant isolation, data mixing, tenant leak, runAcrossTenants, CrossTenantPrismaService, tenant middleware, scoped query, RLS, row level security, row-level security, database role, cannot bypass RLS, app.tenant_id, DATABASE_APP_URL, DATABASE_CROSS_TENANT_URL, permission denied for table, no rows come back, query returns nothing, host not resolving, vault returns nothing, تنانت, ایزولاسیون تنانت, قاطی شدن اطلاعات تنت, داده تنانت قاطی, اسکوپ تنانت]
source:
  - txnet-backend/auth-service/src/app/tenant-context/**
  - txnet-backend/auth-service/src/app/prisma/cross-tenant-prisma.service.ts
  - txnet-backend/prisma/domains/migrations/20260909000500_row_level_security/**
  - txnet-backend/prisma/domains/migrations/20260909001500_row_level_security_all_tables/**
  - txnet-backend/auth-service/src/test-support/postgres-fixture.ts
owns_tables: []
depends_on: [tenant]
updated: 2026-09-09
---

# tenant-context

**Responsibility (one sentence):** carry the tenant a request resolved to, and
make every scoped read and write derive its scope from that rather than from a
caller who remembered to pass it (ADR-0024, catalog 20.2 layer 2).
**Explicitly NOT responsible for:** deciding *which* tenant a request belongs
to — that reads `tenant`'s tables and stays there (§8, ADR-0025).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | reading the context, registering a scoped model, or reading across tenants |

## Status

`active`. **F-066-a** opened the scope at the edge; **F-066-b** made it bind, so
a query on a registered model carries a `tenantId` or throws. **F-066-m-a/-b**
put the rule in Postgres: all 25 `tenantId` tables are policied and the escape
is a second pool. **F-066-n** made all of it measurable —
`isolation-harness.int.spec.ts` asks a real database, not the docs.

## Read first

[ADR-0024](../../architecture/decisions/0024-a-requests-tenant-is-ambient-and-enforced-at-the-data-layer.md)
(ambient, enforced at the data layer — the escape hatch and the session/surface
agreement rule included),
[ADR-0025](../../architecture/decisions/0025-tenant-detection-has-no-fallback.md)
(a resolved tenant, and no fallback). Spec: `tools/spec.py F-1203 F-1202 F-1204`.

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | contract **v6**: the layer becomes measurable. `isolation-harness.int.spec.ts` (catalog 20.2 layer 3) applies the committed migration history and `scripts/db-login-roles.sh`'s SQL to a throwaway Postgres and measures tenant invariant 13's five properties through the production path, with a negative control. spec: F-1204 |
| 2026-09-09 | contract **v5**: every `tenantId` table is policied (25 of 25, three policy shapes), and the escape becomes `CrossTenantPrismaService` on `DATABASE_CROSS_TENANT_URL` — a role whose policy is `USING (true)`, never a bypass. `runAcrossTenants` / `isAcrossTenants` deprecated, no callers left. Consumer: `redis-keyspace`, unaffected. spec: F-1202 |
| 2026-09-09 | contract **v4**: the rule moves into the database. `withTenant(client)` binds `app.tenant_id` in each query's own transaction, RLS policies on `identity.user` + `identity.linked_bot_account` enforce it, and the service connects as a role that cannot bypass them (`DATABASE_APP_URL`). `runAcrossTenants` now returns *no* rows on a policied table — half-retired, finished by F-066-m-b. spec: F-1202 |
| 2026-09-09 | contract **v3**: `withTenant` ships — a query on a registered model is scoped or refused, and `TenantScopeConflict` joins `TenantContextMissing`. spec: F-1203 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
