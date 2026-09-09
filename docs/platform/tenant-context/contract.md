---
id: tenant-context
layer: platform
status: active
version: 6
updated: 2026-09-09
---

# Contract — tenant-context

**Both halves are implemented, and since F-066-m-a the database holds the
same rule.** F-066-a built the ambient scope and its reader; F-066-b built
`withTenant`, the extension that makes forgetting impossible; F-066-m-a made
that extension tell Postgres which tenant each query acts for, so a Row-Level
Security policy — not this code — is what a query is finally answered against.
F-066-m-b extended those policies to every table with a `tenantId` column and
replaced the escape with a pool. Nothing here is intent any more.

## TL;DR

One tenant per unit of work, established once at the edge, readable anywhere,
and injected into every query on a registered model. A query with no tenant in
scope is an error, not an unscoped query.

## Provides

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| `TenantContext.current(what?)` | optional label for the error | `ResolvedTenant` | sync | `TenantContextMissing` when there is no tenant in scope |
| `TenantContext.currentOrNull()` | — | `ResolvedTenant \| null` | sync | none |
| `TenantContext.isAcrossTenants()` **@deprecated** | — | `boolean` | sync | none |
| `runWithTenant(tenant, fn)` | tenant (or `null`), thunk | the thunk's result | sync/async | — |
| `runAcrossTenants(fn)` **@deprecated** | thunk | the thunk's result | sync/async | — |
| `withTenant(client)` (Prisma extension) | the client it is about to extend | an extension, applied once in `prisma.module.ts` | — | `TenantContextMissing`, `TenantScopeConflict` |
| `bindTenantThroughTransaction(client)` | a Prisma client | a `TenantBinder` — `SET LOCAL app.tenant_id` and the query, as one transaction | — | whatever the query throws |
| `TENANT_SCOPED_MODELS` | — | the registry, by Prisma delegate name | — | — |
| `CrossTenantPrismaService` (injected) | — | a Prisma client on the cross-tenant role | — | whatever the query throws |

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
"read every tenant, deliberately" from "this code forgot". It is deprecated on
the same schedule and for the same reason: what it makes observable no longer
works.

`CrossTenantPrismaService` is not a member of this unit's code — it lives in
`prisma/` beside the client it parallels — but it is named here because it is
what rule 4 now *is*, and a reader who arrives at this contract asking "how do
I read across tenants" has to leave with the right answer.

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
4. **One escape, and since F-066-m-b it is a connection, not a callback.**
   Reading across tenants means injecting `CrossTenantPrismaService`
   (`prisma/cross-tenant-prisma.service.ts`) — a second Prisma client on
   `DATABASE_CROSS_TENANT_URL`, the login role `txnet_cross_tenant_user`, whose
   `cross_tenant` policy is `USING (true)`.

   **A policy, never a bypass.** Neither login role holds `BYPASSRLS`. The
   cross-tenant client sees every row because a row in `pg_policy` says so, per
   table, revocable per table with one `DROP POLICY`. That is what makes
   F-1202's "bypassing RLS on the normal pool is not possible" a property of the
   database rather than of the code talking to it: there is no connection string
   in this system that turns the rules off.

   **Four holders, and each one's read is what resolves a tenant.** They are not
   a convenience list — a read belongs here only when the answer *is* the scope:

   | holder | the read | why it cannot be scoped |
   |---|---|---|
   | `TenantResolverService` | `tenant_domain`, `tenant` | which tenant this host is |
   | `CredentialVaultService` | `tenant_dek`, `tenant_credential`, `tenant_credential_access` | reached from `bot-service` and from a webhook, outside any request scope; the `tenantId` argument is the scoping (ADR-0026, tenant invariant 9) |
   | `PrismaBotIntegrationDirectory` | `bot_integration` | which tenant this webhook path is |
   | the e2e harness (`e2e.db()`, `reset()`) | anything | an assertion is not a request |

   The directory also **writes** through it — `recordRegistration` and
   `rotateWebhookPath`. Catalog 20.2 layer 1 names cross-tenant *reads*, so this
   is a deliberate widening: both address a row by primary key, both record what
   the platform just did to an integration it reached by path, and both lack a
   scope for exactly the reason the reads do. Resolving a tenant first, purely
   to check a row the lookup already found, would add a query that could only
   ever agree.

   **Injecting it is the audit.** `grep -rn CrossTenantPrismaService` is the
   whole list, the same way `grep -rn runAcrossTenants` was, with a compiler
   behind it — a constructor is harder to add absent-mindedly than a callback.
   Never add a third client; widen this one's callers, and say in the
   constructor's own doc comment why the read cannot be scoped.

   `runAcrossTenants()` remains, deprecated and uncalled — see Deprecations.

5. **The tenant is bound in the query's own transaction.** `withTenant` does not
   only rewrite arguments any more — it runs
   `set_config('app.tenant_id', …, is_local => true)` and the query as one
   two-statement batch, because Prisma hands out a pooled connection per
   statement and a setting bound anywhere else is bound on a connection the
   query never sees. `is_local` is what makes the setting die with the
   transaction; session-wide it would outlive the request on a pooled
   connection and hand the next tenant the previous one's scope.

   The cost is one transaction per scoped query, and it is the price of the
   layer. The limit is that a registered model **cannot be queried inside an
   interactive `$transaction`** — the batch would nest. No call site does
   (§6.2b), and the failure if one appears is an empty or refused query, never
   a cross-tenant read.
6. **A session's tenant and a surface's tenant must agree.** Both present and
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
- Cross-tenant access is auditable by `grep -rn CrossTenantPrismaService`, and
  the list is four constructors long (rule 4). `runAcrossTenants` has no callers
  at all.
- A top-level query on a registered model either carries a `tenantId` or
  throws. There is no third outcome. `where` is filtered (including a
  `findUnique` on a globally-unique column — Prisma's `WhereUniqueInput` takes
  ordinary filters alongside the unique field, so no operation is rewritten),
  and `create` / `createMany` / the `create` half of an `upsert` are stamped.
- **The database holds the line the extension draws, on every table that has a
  `tenantId`.** All 25 carry `ENABLE`/`FORCE ROW LEVEL SECURITY`, a
  `tenant_isolation` policy for `txnet_app` reading `public.current_tenant_id()`
  and a `cross_tenant` policy for `txnet_cross_tenant`. The service connects as
  `DATABASE_APP_URL`, a login role that owns no table and carries `NOBYPASSRLS`,
  so the policy applies to it — connecting as the owner (`DATABASE_URL`, what
  `prisma migrate` uses) would leave every policy inert, which is why there is
  no fallback between the two. The two `migration.sql` files in
  `20260909000500_row_level_security` and
  `20260909001500_row_level_security_all_tables` are the statement of record,
  and the second one carries the three policy shapes and why each table has the
  one it has.
- **Coverage is asserted rather than trusted.** `rls-coverage.spec.ts` reads
  `prisma/domains/*.prisma` and the migration history and fails on a `tenantId`
  table no policy names. A model that gains the column next month fails on the
  day it is added instead of the day it leaks — which matters because nothing
  else reports it: RLS is not something Prisma models, so a forgotten table is
  green everywhere else.
- What that buys, and it is the point of the layer: a nested write, a relation
  traversal reached through another model's query, and raw SQL are all outside
  the extension — and none of them is outside the policy. What is still outside
  **both** is `tenant.tenant` itself, which has no `tenantId` column and would
  need a policy on `id` (its own row, not this one).
- **The behaviour is measured, not proved once.** `isolation-harness.int.spec.ts`
  (F-066-n, catalog 20.2 layer 3) starts a Postgres, applies the committed
  migration history and the SQL inside `scripts/db-login-roles.sh` — both read
  off disk, so editing either is what turns it red — and then asks the live
  database the questions this section answers in prose: RLS enabled *and* forced
  on every table the schema says carries a `tenantId`, both policies present and
  each granted to its own role, no `txnet_*` role holding `BYPASSRLS` or
  `SUPERUSER`, the app role owning nothing. It then measures the five properties
  tenant invariant 13 had been holding by hand, **through the production path**
  — the real `PrismaService`, the real extension, the real `runWithTenant` —
  because what is in doubt is not whether Postgres works but whether this
  application binds the tenant the policy reads.

  It carries a **negative control**: the migration role is asserted to see both
  tenants. A harness that only ever observes isolation cannot tell a system that
  isolates from a probe that is broken, and this is also the plainest statement
  of why `PrismaService` has no fallback from `DATABASE_APP_URL` to
  `DATABASE_URL` — that fallback reaches exactly this connection, and it looks
  like a working system.

  This is the tier the e2e suite cannot be: `prisma db push` builds a schema
  from `schema.prisma` and skips the migration history, so the e2e database has
  no policies, no `current_tenant_id()` and no roles. A policy test there would
  pass by describing a database nobody ships.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| passing `ResolvedTenant` as a parameter (`RegisterService.register`) | 2026-09-09 (ADR-0024) | **removed 2026-09-09 by F-066-a** — identity contract v8 | `TenantContext.currentOrNull()` |
| `runAcrossTenants(fn)` and `TenantContext.isAcrossTenants()` | 2026-09-09 (F-066-m-b) | F-066-n | inject `CrossTenantPrismaService`. It has no callers left in this repo: all four moved in the same change. It is kept one release rather than deleted beside its replacement (§8), and it no longer works — binding nothing, it is shown no rows on any policied table, which is safe and reads at a call site exactly like the working escape it used to be. A callback cannot be the audit trail for something a connection string decides |
| `resolveTenant(req)` (`tenant`'s request reader) | 2026-09-09 (ADR-0024) | F-066-c | `TenantContext.current()`. Application code no longer calls it; its one caller is `TenantContextMiddleware`, which turns it into the scope. It outlives F-066-b because that middleware still needs a reader for `req.tenant`, and F-066-c is the row that reshapes this seam (`resolve(host)` -> `resolve(claim)`) |
