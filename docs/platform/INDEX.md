---
id: platform-index
status: active
updated: 2026-09-04
---

# Platform

Cross-cutting capabilities used by 2+ units with no business meaning: i18n, observability, error taxonomy, auth middleware, ledger primitives, caching.

| id | responsibility | status | depends_on |
|---|---|---|---|
| i18n | locale-service (gRPC source of truth) + shared Go/Node clients + `locales/` | active | (none) |
| forward-auth | Go Traefik ForwardAuth gateway: JWT + session + RBAC -> identity headers | active | identity, i18n, redis-keyspace |
| redis-keyspace | shared Redis key prefix/versioning + key catalogue + TTLs | active | (none) |

Copy `_TEMPLATE/` to create a new platform unit. Delete files that would be empty.
