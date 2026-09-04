---
id: forward-auth
layer: platform
status: active
version: 1
updated: 2026-09-04
---

# Contract — forward-auth

A single Go binary behind Traefik's `forwardauth` middleware. See ADR-0004.

## TL;DR

Traefik sends every request on a protected router to `GET /validate`. On 2xx the
request proceeds upstream **with** the identity headers; any non-2xx blocks it.
`auth-handler` also strips client-supplied identity headers via a separate
Traefik middleware (`strip-fake-headers`).

## Endpoints

| Method + path | Behaviour |
|---|---|
| `GET /validate` | `Authorization: Bearer <jwt>` -> validate signature (HMAC-SHA256, always HS256) + `exp` + required claims -> check Redis key `<prefix>session:<sessionId>` exists -> if a policy file is loaded, check every claimed permission is granted to `roleId` -> set identity headers, return 200 |
| `GET /health` | 200 `healthy` |

## Response headers on success

`X-User-Id` (`sub`), `X-Tenant-Id`, `X-Role-Id`, `X-User-Permissions`
(comma-joined), and when impersonating: `X-Impersonated: true`,
`X-Impersonated-By`. Traefik is configured to forward exactly these
(`authResponseHeaders`).

## Status mapping

- 200 valid. 401 missing/invalid/expired token or missing session marker
  (`missing_bearer_token`, `unauthorized`, `session_revoked`). 403 policy denies
  a claimed permission (`forbidden`). 500 Redis lookup error / unexpected. The
  internal message key is mapped to the status **before** translation, then the
  body `msg` is localized via `i18n` (namespace `messages`, `Accept-Language`).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | the JWT claim shape + the meaning of a live session | cannot authorize -> everything protected fails closed |
| redis-keyspace | `<REDIS_KEY_NAMESPACE>:<REDIS_KEYSPACE_VERSION>:session:<id>` must match what `auth-service` writes | mismatch = every request looks "revoked" |
| i18n | localize the response `msg` (`scope=backend`, namespace `messages`) | falls back to the raw key |

## Config

`JWT_SECRET` (or `JWT_ACCESS_SECRET`) — must equal `auth-service`'s;
`REDIS_URL`; `REDIS_KEY_NAMESPACE` / `REDIS_KEYSPACE_VERSION` — must equal
`auth-service`'s; `PERMISSIONS_FILE_PATH` (`configs/permissions.yaml`, optional —
absent disables the RBAC step); `LOCALE_SERVICE_ADDR` / `LOCALE_SCOPE=backend`;
HTTP timeouts. Policy file format: `roles: <role>: permissions: - <key>`.

## Guarantees

- Fail-closed: any error or unmet check returns non-2xx, so Traefik blocks the
  request.
- `alg` confusion is not possible — verification always uses HS256.
- The gateway never writes to Redis or Postgres; it is read-only.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `LOCALES_DIR` / `LOCALES_WATCH` config fields | 2026-09-04 | — | `locale-service` is the only file reader |
