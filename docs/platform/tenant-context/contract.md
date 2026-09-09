---
id: tenant-context
layer: platform
status: active
version: 3
updated: 2026-09-09
---

# Contract — tenant-context

**Both halves are implemented.** F-066-a built the ambient scope and its
reader; F-066-b built `withTenant`, the extension that makes forgetting
impossible. Nothing here is intent any more.

## TL;DR

One tenant per unit of work, established once at the edge, readable anywhere,
and injected into every query on a registered model. A query with no tenant in
scope is an error, not an unscoped query.

## Provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `TenantContext.current(what?)` | optional label for the error | `ResolvedTenant` | sync | `TenantContextMissing` when there is no tenant in scope |
| `TenantContext.currentOrNull()` | — | `ResolvedTenant \| null` | sync | none |
| `TenantContext.isAcrossTenants()` | — | `boolean` | sync | none |
| `runWithTenant(tenant, fn)` | tenant (or `null`), thunk | the thunk's result | sync/async | — |
| `runAcrossTenants(fn)` | thunk | the thunk's result | sync/async | — |
| `withTenant()` (Prisma extension) | — | an extension, applied once in `prisma.module.ts` | — | `TenantContextMissing`, `TenantScopeConflict` |
| `TENANT_SCOPED_MODELS` | — | the registry, by Prisma delegate name | — | — |

`ResolvedTenant` is `tenant`'s type and is re-exported, never redefined
(`txnet-backend/auth-service/src/app/tenant/tenant.ts`).

`current()` takes an optional label naming what was being attempted; it appears
in the thrown message, because the whole value of throwing is that the report
says where the missing scope was needed.

`withTenant()` is not injected or called by anything but `prisma.module.ts`.
The `PrismaService` token resolves to the extended client, so a service that
injects `PrismaService` is scoped without knowing this unit exists — which is
the point: `$extends` returns a *new* client rather than mutating one, and a
subclass cannot override a model accessor because Prisma defines those on the
instance.

`TenantScopeConflict` is separate from `TenantContextMissing` because the fix
differs: missing means nobody opened a scope, conflict means the query and the
scope name different tenants.

`isAcrossTenants()` is not a second reader of the tenant — it is how
`runAcrossTenants` is observable at all. Without it the escape would be
indistinguishable from ordinary work and F-066-b's extension could not tell
"read every tenant, deliberately" from "this code forgot".

## The rules this unit exists to hold

1. **Entered once, at the edge.** `TenantContextMiddleware` runs `next()`
   inside the scope, immediately after `TenantMiddleware` resolved the tenant,
   on every route. No handler opens its own; a route that resolved its own
   tenant would resolve it differently the first time someone forgot to.

   ADR-0024 says `TenantMiddleware` itself opens the scope. It does not, and
   the reason is structural: this unit already depends on `tenant` for
   `ResolvedTenant` and for `resolveTenant(req)`, so having `tenant`'s
   middleware call `runWithTenant` would make the two units depend on each
   other. Two middlewares in a fixed order, one edge, one direction (§8).

   A request that resolved to **no** tenant still gets a scope, carrying
   `null`. "Resolved to nothing" and "nobody opened a scope" are different
   failures with different fixes, and only the second is a bug in this
   codebase — a detached timer or a queue consumer written later (ADR-0024's
   accepted cost).
2. **A registered model is always scoped.** The registry is explicit — a model
   gaining a `tenantId` column does not silently change how it is queried. The
   first entry is `User`; `LinkedBotAccount` joins it with F-066-l.
3. **No context is an error.** The extension throws `TenantContextMissing`
   rather than running the query unscoped. The wrong answer here is a
   cross-tenant read, so failing loud is the only safe default. The same
   applies to an operation the rewriter does not recognise: an unknown
   operation is refused, never passed through.
3b. **A query that names another tenant is refused, not corrected.** Silently
   replacing an explicit `tenantId` would turn a deliberate cross-tenant
   question into a quiet same-tenant answer — a wrong result rather than a
   refused one. A matching `tenantId` is left as it is.
4. **One escape, by name.** `runAcrossTenants()` is the sole way to read across
   tenants, and it is a single greppable symbol. **Await inside it**: a Prisma
   promise is lazy, so a scope the caller has already returned from is a scope
   the query never ran in. It is a stopgap for F-1202,
   where the escape becomes a separate database role and pool that cannot bypass
   RLS at all. Never add a second escape; widen this one's callers instead.
5. **A session's tenant and a surface's tenant must agree.** Both present and
   different is a refusal, not a preference for one. This is the leak ADR-0024
   records: today a tenant-A user can authenticate through tenant-B's host.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | `ResolvedTenant`, and the resolution itself | no scope is opened; every scoped query then throws, which is the intended failure |

## Emits (events)

None, and none planned. This unit decides nothing and owns no state.

## Guarantees

- The scope survives every `await`, timer and `Promise.all` inside one request,
  and two concurrent requests never see each other's tenant.
- The scope is closed when the work ends, including when it throws.
- Reading the context never performs I/O — resolution happened at the edge.
- `runAcrossTenants` is auditable by `grep -rn runAcrossTenants`. Its only
  caller is the e2e harness's `e2e.db()`, which reads rows from outside any
  request — no production read has needed it yet.
- A top-level query on a registered model either carries a `tenantId` or
  throws. There is no third outcome. `where` is filtered (including a
  `findUnique` on a globally-unique column — Prisma's `WhereUniqueInput` takes
  ordinary filters alongside the unique field, so no operation is rewritten),
  and `create` / `createMany` / the `create` half of an `upsert` are stamped.
- **Not** guaranteed: a nested write or a relation traversal reached through
  another model's query. Those are scoped by their foreign key, not by this
  extension, and raw SQL (`$executeRawUnsafe`) is outside it entirely — the
  reason F-1202's RLS (F-066-m) is still the backstop under this.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| passing `ResolvedTenant` as a parameter (`RegisterService.register`) | 2026-09-09 (ADR-0024) | **removed 2026-09-09 by F-066-a** — identity contract v8 | `TenantContext.currentOrNull()` |
| `resolveTenant(req)` (`tenant`'s request reader) | 2026-09-09 (ADR-0024) | F-066-c | `TenantContext.current()`. Application code no longer calls it; its one caller is `TenantContextMiddleware`, which turns it into the scope. It outlives F-066-b because that middleware still needs a reader for `req.tenant`, and F-066-c is the row that reshapes this seam (`resolve(host)` -> `resolve(claim)`) |
