---
id: forward-auth
layer: platform
status: active
version: 2
updated: 2026-09-08
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
  (`auth.authorizationRequired`, `auth.invalidToken`, `auth.sessionRevoked`).
  403 policy denies a claimed permission (`permissions.forbidden`). 500 Redis
  lookup error / unexpected (`system.unexpected`). 503 the request outlived the
  gateway's timeout (`system.unavailable`). The key is mapped to the status
  **before** translation.

## Every answer is the envelope, and `msg` is a sentence

`{ok, msg}`, with `msg` translated into `Accept-Language` from the shared
backend `errors` namespace (`locales/backend/langs/*/errors.json`) — the same
catalogue `auth-api` translates against.

- A key here **must exist in `errors`**. Until v2 this gateway translated
  against a namespace called `messages`, which `locale-service` does not serve
  and never did: every lookup fell through and the client was sent the raw key
  (`session_revoked`). A caller shows `msg` to a person, so its language is not
  a nicety.
- The answers no handler wrote — a recovered panic, a timeout — carry the same
  envelope in the same language. `Recoverer` and `Timeout` therefore sit
  **inside** `LanguageMiddleware`; `cmd/server/main.go` says so.
- A 2xx body is consumed by Traefik and never reaches a person, so success is
  not translated.
- Nothing internal is ever on the wire: a Go error's text and a panic value go
  to the log alone (`response.SafeExecute`), the rule `auth-api`'s
  `sanitizeError` follows on the other side.

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
