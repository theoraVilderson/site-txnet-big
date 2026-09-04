---
id: arch-overview
status: active
updated: 2026-09-04
---

# Architecture overview

## What the system does

TXNet is a multi-tenant, white-label reseller platform for VPN / digital
services. One **platform owner** operates the system; many **resellers**
(tenants) sell to end users under their own brand, domain, pricing, payment
gateway and Telegram/Bale bot. The platform bills tenants (subscription or
metered usage); tenant end users pay their own tenant through that tenant's own
gateway — **tenant money never flows through the platform** (ADR-0006).

Today only identity/auth is implemented. Every other business domain
(`tenant`, `billing`, `network`, `currency`, ...) exists as a Prisma schema with
rich intent comments but no service — those doc units are `draft`.

## Runtime topology

```
internet -> Traefik (TLS, routing)
              |-- ForwardAuth middleware --> auth-handler (Go)  : JWT + Redis session + RBAC
              |-> auth-service (NestJS)   /api/auth/*, /api/i18n/*, /admin/*
              |-> billing-service (NestJS, scaffold, behind ForwardAuth)
              |-> site-pwa (Next.js)      panel.<domain>
              |-> coinsite (Next.js)      <domain>
locale-service (Go gRPC :50051) <- every backend/frontend preloads a scope on boot, then Watch stream
Postgres (multiSchema) · Redis (sessions, OTP, rate limits) · RabbitMQ (declared, unused in code)
```

Transports: HTTP/JSON between browsers and services; HTTP ForwardAuth sub-request
Traefik -> auth-handler; gRPC (HTTP/2 + protobuf) service -> locale-service.

## Boundaries

- **Tenancy boundary:** every tenant-scoped table carries `tenantId`; one row of
  `Tenant` is `platform_owner`. Structural isolation (Postgres RLS, partial
  unique indexes, multi-column CHECKs) is specified as manual migration SQL
  ("section 99" in the schema) but **not yet applied** — see
  `security/threat-model.md` and ADR-0001.
- **Trust boundary:** everything from the browser is untrusted. Traefik strips
  client-supplied `X-User-*` / `X-Tenant-*` / `X-Role-*` headers; only
  `auth-handler` may set them after validating the JWT and Redis session.
- **Transaction boundary:** money mutations are a single Postgres transaction
  that appends a ledger row and updates the cached balance (ADR-0002). Locale
  reload, fraud scans, usage metering are eventually consistent.

## Non-goals

- The platform does not custody or route tenant end-user funds.
- No per-language configuration: clients load every language `locale-service`
  advertises.
- `billing-service` is not a second copy of billing logic — it is an empty Nx
  app placeholder.
