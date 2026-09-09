---
id: adr-0024
status: accepted
updated: 2026-09-09
---

# ADR 0024 — A request's tenant is ambient, and enforced at the data layer

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** tenant-context, tenant, identity, auth-api, bot-app, redis-keyspace

## Context

ADR-0020 gave a request a resolved tenant. Nothing makes a query *use* it.
`RegisterService` takes a `ResolvedTenant` as a fourth positional argument
(`register.controller.ts` -> `register.service.ts`), and it is the only caller
in the process that does. Every other lookup — roughly thirteen of them, by
phone number or username across login, forgot-password, the OTP senders,
bot-link and bot-session — queries `user` with no tenant in the `where` clause
at all.

ADR-0023 asks for those to become tenant-scoped. Threading a parameter through
each is the obvious move and the wrong one: it is thirteen signature changes
today, §6.2b's call-site listing paid on every one, and — the part that
matters — a fourteenth call site written next month is scoped only if its
author remembers. A rule enforced by memory is not a tenancy boundary; it is a
convention that will be violated, and `security/threat-model.md` already names
"a missing filter in any query" as the live cross-tenant risk.

There is also a second, unrecorded leak. The access token's `tenantId` comes
from `user.tenantId` (`token.service.ts`), while the request's tenant comes
from the host, and nothing compares the two. Because the login lookup is
unscoped, a user of tenant A authenticating through tenant B's host is found,
matched, and issued a valid tenant-A token. That is cross-tenant mixing today,
with no bot involved.

The feature catalog answers this directly (20.2, "Multi-Tenant Isolation — Six
Layers"): layer 2 is *"a tenant-scoped Prisma extension; every query passes
through `withTenant`"*.

## Decision

**The request's tenant is ambient, and the data layer enforces it.**

1. **Carried, not passed.** An `AsyncLocalStorage` scope is entered once, at the
   edge, by `TenantMiddleware`. Code reads `TenantContext.current()`; no service
   takes a tenant parameter.
2. **Enforced by a Prisma client extension** (`withTenant`, the catalog's name),
   over an explicit registry of tenant-scoped models. Every query on a
   registered model has `tenantId` injected into its `where` and into
   `create.data`, and **throws** when there is no ambient context. Forgetting is
   no longer possible; the failure mode is a loud error, not a silent leak.
3. **One escape hatch, named and audited.** `runAcrossTenants()` is the only way
   to read across tenants. It is a single greppable symbol, used by the resolver
   itself and by platform-owner reads. It is a stopgap for F-1202, where the
   escape becomes a separate database role and connection pool that cannot
   bypass RLS at all.
4. **A session's tenant and a surface's tenant must agree.** When a request
   carries both and they differ, it is refused. This closes the leak above.

The registry is explicit rather than "every model with a `tenantId` column",
because a model gaining that column should be a deliberate decision about
scoping, not an automatic change in query behaviour.

## Consequences

- Positive: ADR-0023's thirteen lookup sites become zero — they are scoped
  without being edited, and so is every site written after this.
- Positive: the same context serves the Redis key builders, so tenant-segmented
  keys (F-065-c) also stop needing a new parameter.
- Positive: a missing tenant is an error at the query, near the cause, rather
  than a wrong row returned far from it.
- Negative / accepted cost: scoping becomes invisible at the call site. A reader
  of `register.service.ts` no longer sees the tenant in the signature, and has
  to know the extension exists. This is the standard cost of ambient context and
  it is why the escape hatch is a loud, greppable name.
- Negative / accepted cost: `AsyncLocalStorage` has a real, small overhead, and
  any code that escapes the async context (a detached timer, a queue consumer
  built later) has no tenant and will throw. That is the correct failure, but it
  is a failure someone has to handle when workers arrive.
- Negative / accepted cost: an extension that rewrites queries can surprise —
  a `findUnique` on a globally-unique column becomes a `findFirst`-shaped
  question once a tenant is added.
- Forecloses: passing a tenant explicitly as the primary mechanism; a
  "trust the caller to filter" data layer.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Thread `ResolvedTenant` through every signature | fully explicit, no magic — but it is enforced by memory, and the fourteenth call site is the one that leaks. §6.2b makes each change safe and none of them make the next one safe |
| Postgres RLS alone | the real backstop and it is still wanted (F-1202), but it is a migration this codebase has not applied ("section 99"), it cannot express "no tenant means refuse", and it gives no error the application can translate |
| A repository layer wrapping Prisma | one place to enforce scoping, but it is a large rewrite of working code and it is bypassable the moment someone injects `PrismaService` directly |

## Revisit trigger

F-1202 lands and RLS enforces isolation in the database. The extension then
becomes defence in depth rather than the boundary, and `runAcrossTenants` is
replaced by the admin pool.
