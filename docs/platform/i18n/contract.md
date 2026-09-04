---
id: i18n
layer: platform
status: active
version: 1
updated: 2026-09-04
---

# Contract — i18n

The gRPC contract is the source of truth:
`i18n-platform/proto/locale/v1/locale.proto`. See also ADR-0003.

## TL;DR

`locale-service` reads `locales/` and serves it over gRPC on `:50051`. Every
consumer blocks on boot until the first snapshot is cached, then holds a `Watch`
stream so edits reload live. One Go client, one Node client — no per-service
copies.

## RPCs

| RPC | Kind | Use |
|---|---|---|
| `GetSnapshot(lang, scope)` | unary | blocking boot; returns flat dot-notation entries per namespace + a `version` (sha1) |
| `GetAvailableLocales()` | unary | language list + metadata (dir, native name, BCP-47) |
| `Watch(langs, scope)` | server-stream | one full snapshot per change for each matching (lang, scope) |

`scope` = `backend` \| `frontend` \| `""`. A named scope is always returned
merged with the `shareds` namespaces; `""` returns every scope with namespace
keys prefixed `"<scope>/"`. Empty `langs` = all languages (new languages are
picked up automatically).

## Client API (identical semantics in Go and Node)

`ready()`/`New()` blocks until first snapshot or boot timeout (then fails fast);
`t/T(lang, ns, key, vars)` with `{{var}}` interpolation; `translate` without;
`namespace(lang, ns)`; `resolveLanguage(acceptLanguage)`; `languages()`;
`resync()`; `close()`. Missing key -> the key itself (never throws/panics).
Cache is replaced atomically per language, never merged. Reconnect uses
exponential backoff and re-fetches on recovery.

## Consumers

| Consumer | Resolution | Scope |
|---|---|---|
| `auth-handler` (Go) | `github.com/txnet/i18n-platform/clients/go` via `go.work` / `replace` | backend |
| `txnet-backend/auth-service` (Node) | `@txnet/locale-client` from `vendor/locale-client.tgz` | backend |
| `site-pwa` (Node, server only) | `@txnet/locale-client` from `vendor/locale-client.tgz` | frontend |

## On-disk layout it reads (`locales/`)

```
locales/backend/langs/<lang>/<namespace>.json
locales/frontend/langs/<lang>/<namespace>.json
locales/shareds/<lang>/<namespace>.json
locales/<scope>/langs/<lang>/metadata.json    # reserved: locale metadata
```

Namespaces present today: backend = `errors`, `metadata`, `notifications`;
frontend = `auth`, `common`, `metadata`, `validations`. `shareds/*` is empty.

## Change workflow

- Proto change: `cd i18n-platform && make proto` (regenerates Go stubs in
  `services/locale-service` + `clients/go`), then hand-edit
  `clients/node/proto.ts`, then `make sync-node`.
- Node client change: `make sync-node` -> copies `vendor/locale-client.tgz` to
  every consumer; then `npm install` in each.

## Guarantees

- Boot dependency: a consumer that cannot reach `locale-service` within its boot
  timeout **fails to start** (exit non-zero / rejected `ready()`).
- Snapshot `version` is a stable sha1 over the sorted namespace/entry set.
- `locale-service` keeps the last good tree if a reload fails to parse.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| "vendor a per-service copy of the client" (stale comment in `client.go` / `client.ts`) | 2026-09-04 | — | the one shared Go module + one shared Node tarball (ADR-0003, README) |
| `LOCALES_DIR` / `LOCALES_WATCH` env in consumers | 2026-09-04 | — | only `locale-service` reads files now |
