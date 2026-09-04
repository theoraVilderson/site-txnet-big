---
id: interfaces-index
status: active
updated: 2026-09-04
---

# Interfaces

Every external touchpoint: HTTP API, bot, admin panel, webhook receiver, CLI. Translation only — no business rules.

| id | responsibility | status | depends_on |
|---|---|---|---|
| auth-api | NestJS auth-service HTTP API (`/api/auth`, `/api/i18n`, `/admin`) | active | identity, i18n, redis-keyspace |
| panel-web | Next.js user panel (site-pwa) + API proxy | active | auth-api, i18n |
| marketing-web | Next.js public landing site (coinsite) — skeleton | draft | (none) |

Copy `_TEMPLATE/` to create a new interface. Delete files that would be empty.
