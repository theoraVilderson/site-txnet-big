---
id: adr-0100
status: accepted
updated: 2026-09-28
---

# ADR 0100 — currency-service is the currency unit's HTTP home

- **Status:** accepted
- **Date:** 2026-09-28 (rows F-116-k, F-0608-a, F-116-j)
- **Affects units:** currency, forward-auth, ops-observability
- **Supersedes:** —

## Context

The `currency` unit had code in two places: the FX worker (`worker-service`,
which serves no requests, ADR-0027) and the rate reader in `shared-core`. A
manual rate (F-0608-a, F-116-j) needs an HTTP API for the platform admin and
for a tenant's admin, and the unit's other intended operations (display
currency, user preference, currency lock — `currency/contract.md`) need one
too. Candidates were `tenant-service` (it already hosts the operating-currency
choice), `billing-service` (the main consumer of a rate), or a new service.

## Decision

1. **A new Nest app, `currency-service`, serves every `/api/currency/*` route.**
   It is the `currency` unit's code, like the worker's `currency/` folder, and
   the place every future currency operation goes.
2. **It is an ordinary tenant-facing service**: behind Traefik and ForwardAuth,
   the RLS app pool plus the cross-tenant pool, the shared guards
   (`PublicRouteGuard`, `RateLimitGuard`, `TenantStatusGuard`, C-11), locale
   through `locale-service`, Redis for the rate keys.
3. **It does not fetch rates.** Discovery stays in the worker (F-0603…F-116-i2).
   This service reads rates through shared-core `readFxRate`, and writes only
   what a person decides: a manual rate.
4. **The operating-currency choice stays in `tenant-service`** (F-116-a/f): it
   converts a tenant's money, which is `tenant`'s and `billing`'s business, not
   a rate's.

## Consequences

- One more process to build, run and watch; it is small and stateless.
- A rate's writes have one home per kind: the worker for discovered rates, this
  service for pinned ones. Neither writes the other's.
- The user chose this over `tenant-service` (cheaper today) so that the unit's
  later operations do not end up spread over services that do not own them.

## Revisit trigger

A second process needs to write rates, or the service grows a responsibility
that is not currency.
