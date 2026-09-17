---
id: adr-0058
status: accepted
updated: 2026-09-17
---

# ADR 0058 — Tenant administration leaves auth-service

- **Status:** accepted 2026-09-17 with F-018-t (user; rows F-018-t … F-018-z, F-019-h, F-061-c)
- **Date:** 2026-09-17
- **Affects units:** tenant, identity, auth-api, notification, automation

## Context

Every tenant administration route grew inside `auth-service` with no decision
recording why: resellers (F-018-c), packages (F-018-d), subscription and grace
(F-018-e, F-019-g), status (F-018-f/s) and renewal (F-019-c) — about 2,000 lines
under `auth-service/src/app/tenant/`. F-018-q made the cost visible: to let the
platform owner stop a reseller's campaigns, `auth-service` began writing a
campaign outbox event, i.e. authentication code learned that campaigns exist.
The user (2026-09-17): "it must be separate".

## Decision

1. **A new Nx app, `tenant-service`**, owns tenant administration: resellers,
   packages, subscription, grace, renewal, status and `TenantStatusListener`.
   It reads identity from the gateway headers as `notification-service` does,
   and registers `TenantStatusGuard` (C-11).
2. **`auth-service` keeps only request-tenant resolution** — `TenantResolverService`,
   `TenantCacheService`, `TenantGuard`: which tenant a sign-in belongs to is
   authentication. It keeps reading `tenant:status:<id>` like every service.
3. **Public paths change now**: `/api/auth/tenants*` -> `/api/tenants*`,
   `/api/auth/tenant-packages*` -> `/api/tenant-packages*`. No panel calls them
   yet (F-018-k is `todo`), so the rename breaks nothing today (user).
4. **A reseller is not created with a new user.** A person signs up on the
   platform's own site, and becomes a reseller by buying a reseller package;
   the same person may also be a customer (user, 2026-09-17). `tenant-service`
   therefore never writes `identity.user`: a reseller names an existing user as
   its owner. How that user reaches the reseller's panel is F-061-c.
5. **`tenant-service` does not know campaigns exist.** `stopCampaigns` leaves
   the status change; the panel calls notification-service's own
   `POST /api/notifications/campaigns/tenants/:tenantId/stop` after a suspension.
   A failure is shown at once and retried by the owner — no silent dead letter
   (F-018-x, supersedes F-018-q's outbox path).

## Alternatives

| Option | Why not |
|---|---|
| Keep it in `auth-service`, routed as `/api/tenants` by Traefik | every tenant feature keeps coupling authentication to other domains; the path would lie about the service |
| `tenant-service` writes the owner's `user` row itself | it would have to know how passwords are stored — the coupling this ADR removes |
| Rename paths after the panel exists | the panel breaks on the rename |

## Consequences

- One more service to deploy and monitor (dev compose, swarm, Traefik).
- Callers of the moved internal routes (`worker-service` renewal) change base URL.
- F-018-c's "platform owner creates a reseller with a new owner user" is replaced.
- Accepted when F-018-t shipped (2026-09-17): `tenant-service` runs with no business routes; the moves are F-018-u … F-018-z.
