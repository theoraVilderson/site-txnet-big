---
id: adr-0057
status: accepted
updated: 2026-09-17
---

# ADR 0057 — A tenant's status is one matrix, enforced in each service

- **Status:** accepted 2026-09-17 (row F-018-f)
- **Date:** 2026-09-17
- **Affects units:** tenant, identity, billing, redis-keyspace

## Context

`tenant.status` existed with four values and nothing read it: a suspended or
terminated reseller resolved and served like any other (open question
2026-09-09). D-42 (1) chose staged suspension — panel read-only, billing open,
end users in but buying nothing, `/sub` held a few days — and termination by
hand. Three things made the enforcement point non-obvious:

- the gate (`auth-handler`) has no tenant (ADR-0024), so it cannot decide;
- the rules cut across routes in two services by *what a route does*, not by
  path or by permission — a reseller's staff and its end users share both;
- a status change must bind at once, not when a cache expires.

## Decision

1. **One matrix, status × capability, in shared-core** (`TenantStatusPolicy`).
   The prose home is `domains/tenant/rules.md`; no other place decides.
2. **Each route declares a capability; an undeclared mutating route is a staff
   write** (the user's call: fail closed). A route added later is closed for a
   suspended tenant without its author remembering the rule exists.
3. **One guard, `TenantStatusGuard`, registered in every service that serves a
   tenant's users** (auth-service, billing-service), reading the ambient tenant.
4. **Redis carries the state, pushed from Postgres** — F-101-b's pattern: a
   trigger notifies, auth-service LISTENs and rewrites `tenant:status:<id>`,
   recomputing every tenant on connect. A missing key refuses nobody.
5. **Settlement is never closed** (`system`): a gateway already took the money.
6. **`/sub` gets its column and `graceEndsAt` now**; its server (`network`)
   enforces it when it exists.

## Consequences

- A new service serving tenant users must register the guard and label its
  routes; forgetting to label a write closes it (safe), forgetting the guard
  opens everything (unsafe) — that is a review rule.
- Between a Redis flush and the listener's next connect, statuses are not
  enforced. Accepted, as for permissions (ADR-0043 §3).
- The LISTEN loop is shared (`auth-service/src/app/prisma/pg-notification-listener.ts`).
- The onboarding gate (F-018-l) is a further column of the same matrix.

## Alternatives rejected

- **Enforce at the gate:** it has no tenant (ADR-0024).
- **Refuse by path or by permission key:** staff and end users share paths
  and permission keys do not say "is a sale".
- **Read `tenant.status` from Postgres per request:** a query on every call in
  two services, and billing's app pool sees only its own scope.
- **Opt-in labels (open unless labelled):** cheaper today; every unlabelled
  write stays open for a suspended reseller forever.
