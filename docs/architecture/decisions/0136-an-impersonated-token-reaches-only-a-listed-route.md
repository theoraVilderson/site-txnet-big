---
id: adr-0136
status: active
updated: 2026-10-14
---

# ADR 0136 — an impersonated token reaches only a listed route

- **Status:** accepted (row AC-1-g)
- **Date:** 2026-10-09
- **Affects units:** forward-auth, identity
- **Decision:** the user's, 2026-10-09 — both answers as recommended

## Context

Catalog §3.6 layer 4: the paths an impersonating admin may not use (password,
2FA, wallet manual adjust, credentials, gateways, plans, account delete, AI
provider settings) are enforced as an **allowlist**, so a new path is closed
until someone opens it. What existed was the opposite: three auth-service
routes carried `SensitiveActionGuard`, and every billing, tenant, support,
notification and ai route admitted an impersonated token unchecked.

There are ~590 routes across nine services. auth-service is not behind the
gate (its router has no `my-auth`); it checks tokens in its own `AuthGuard`.

## Decision

1. **One list, as a contract file.** `contracts/http/impersonation.json`:
   `allow` rows of `{method, path}`, the public path with `:name` for one
   segment. auth-handler and shared-core each hold a copy pinned to it by a
   test, the way `wire.json` is held (ADR-0036) — neither language reads the
   other's code, and no deploy mounts a new file.
2. **Two enforcers, the same rule.** auth-handler refuses an impersonated token
   whose `X-Forwarded-Method` + `X-Forwarded-Uri` is not a row; auth-service's
   `AuthGuard` does the same for its own routes from `request.originalUrl`.
   The answer is 403 `impersonation.blockedAction`, `error.reason:
   impersonationBlocked`. A path not already clean (`..`, `%`, `//`, a trailing
   `/`) or with no method is refused, not resolved.
3. **Held mechanically.** `tools/contracts.py` fails when a row names no Nest
   route (a renamed route the list closed by accident), falls under a `never`
   prefix, or holds a `neverWords` word (§3.6's forbidden categories).
4. **What is on it: the user's own panel**, reading and writing — services,
   wallet history, invoices and paying from the wallet, support
   conversations, notifications, lotteries, wheel, AI suggestion — minus the
   forbidden categories. Not on it: every staff and reseller route, even when
   the person impersonated is staff; the account switcher, handoff and
   sessions (they mint or end sessions); config lines and subscription links
   (credentials); buying a reseller package (plans); a deposit (the
   person's own payment, and a gateway leaves the tab — ADR-0146).

## Consequences

- Support can reproduce what a user sees and does ("the purchase fails"),
  and nothing else. A support need not on the list is a one-row change plus
  the check.
- Staff pages under impersonation are closed until AC-1-h's rank ceiling is
  in and a separate decision opens them.
- The panel (AC-1-i) must treat a 403 `impersonationBlocked` as "not available
  while signed in as this user", never as a sign-out — the account switcher and
  the sessions page will answer it.

## Rejected

- **A list in Go only** (like `restrictedReach`): cheapest, but nothing would
  compare it with the Nest routes, and auth-service's routes stay uncovered.
- **`@ImpersonationAllowed()` on each route, generated into a file**: keeps the
  decision beside the code but adds a generator and a build step; it can be
  layered on this file later without changing either enforcer.
- **Reads only**: safer, but support could not reproduce a failed purchase.
