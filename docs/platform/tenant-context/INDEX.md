---
id: tenant-context
layer: platform
status: active
version: 3
keywords: [tenant context, ambient tenant, withTenant, tenant scoping, cross-tenant, tenant isolation, data mixing, tenant leak, runAcrossTenants, tenant middleware, scoped query, تنانت, ایزولاسیون تنانت, قاطی شدن اطلاعات تنت, داده تنانت قاطی, اسکوپ تنانت]
source:
  - txnet-backend/auth-service/src/app/tenant-context/**
owns_tables: []
depends_on: [tenant]
updated: 2026-09-09
---

# tenant-context

**Responsibility (one sentence):** carry the tenant a request resolved to, and
make every tenant-scoped read and write derive its scope from that rather than
from a caller who remembered to pass it (ADR-0024, catalog 20.2 layer 2).
**Explicitly NOT responsible for:** deciding *which* tenant a request belongs to
— that rule reads `tenant`'s tables and stays in `tenant` (§8, ADR-0025).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | reading the context, registering a scoped model, or reading across tenants |

## Status

`active`, and both halves are built: **F-066-a** opened the scope at the edge,
**F-066-b** made it bind — the `PrismaService` token resolves to a client
extended with `withTenant`, so every query on a registered model carries a
`tenantId` or throws, with no way to opt in or out. Raw SQL and nested relation
writes are outside it; RLS (**F-066-m**) is the backstop.

## Read first

[ADR-0024](../../architecture/decisions/0024-a-requests-tenant-is-ambient-and-enforced-at-the-data-layer.md)
(ambient, and enforced at the data layer — including the escape hatch and the
session/surface agreement rule),
[ADR-0025](../../architecture/decisions/0025-tenant-detection-has-no-fallback.md)
(what a resolved tenant means, and that there is no fallback).
Spec: `python3 tools/spec.py F-1203`.

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | contract **v3**: `withTenant` ships — a query on a registered model is scoped or refused, and `TenantScopeConflict` joins `TenantContextMissing`. spec: F-1203 |
| 2026-09-09 | `draft` -> **`active`**, contract v2: the ambient carrier ships (`TenantContext`, `runWithTenant`, `runAcrossTenants`, `TenantContextMiddleware`). `RegisterService.register`'s tenant parameter is gone — identity v8. spec: F-1203 |
| 2026-09-09 | Unit created, `draft`. ADR-0024 decides that a request's tenant is ambient and enforced by a Prisma extension rather than threaded through ~13 signatures |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
