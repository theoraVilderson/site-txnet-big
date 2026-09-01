# i18n-platform — TXNet Locale Platform (real gRPC)

`locale-service` is the **source of truth** for every translation string. Backend
and frontend services don't read `locales/*.json` from disk any more — they open a
gRPC connection to `locale-service`, block until the first snapshot is cached, and
then stay connected so edits reload live.

```
                 ┌───────────────────────────┐
   locales/  ───▶│  locale-service (Go, gRPC) │  :50051
   (on disk)     │  fsnotify → reload → push  │
                 └────────────┬──────────────┘
             GetSnapshot / Watch (HTTP/2 + protobuf)
        ┌────────────┬─────────┴───────────┬─────────────┐
        ▼            ▼                     ▼             ▼
  auth-handler   auth-service          site-pwa       (any future
   (Go client)   (Node client)     (Node client,      service)
   scope=backend  scope=backend    server side only,
                                    scope=frontend)
```

## Layout

```
i18n-platform/
├── proto/locale/v1/locale.proto        # the gRPC contract (source of truth for the API)
├── services/locale-service/            # Go gRPC server — reads ../../locales
│   ├── cmd/server/main.go
│   └── internal/{localev1,store,watcher,server}
├── clients/
│   ├── go/                             # shared Go module   (github.com/txnet/i18n-platform/clients/go)
│   └── node/                           # shared Node package (@txnet/locale-client, ships compiled dist/)
├── codegen/{ts,go}/                    # reference-language → typed keys (optional prebuild step)
└── Makefile                            # `make proto`, `make sync-node`, `make run-service`
```

## One shared client — no per-service copies

Every consumer resolves the **same** client. There are no hand-maintained copies,
so a fix to `clients/go` or `clients/node` reaches all consumers with one command.

| Service | How it resolves the client | Scope |
|---|---|---|
| `auth-handler` (Go) | imports `github.com/txnet/i18n-platform/clients/go` | `backend` |
| `txnet-backend/auth-service` (Node) | `@txnet/locale-client` via `file:./vendor/locale-client.tgz` | `backend` |
| `site-pwa` (Next, server only) | `@txnet/locale-client` via `file:./vendor/locale-client.tgz` | `frontend` |

### Go — a real module (`go.work` in dev, `replace` in Docker)

`auth-handler/go.mod` has:

```
require github.com/txnet/i18n-platform/clients/go v0.0.0
replace github.com/txnet/i18n-platform/clients/go => ../i18n-platform/clients/go
```

Local builds also see it through the repo-root `go.work` (`use ./i18n-platform/clients/go`).
Docker builds set `GOWORK=off` and `COPY i18n-platform/clients/go/` into the build
context, so the `replace` directive resolves. Nothing is copied into `auth-handler/`.

### Node — a compiled tarball (`@txnet/locale-client`)

`clients/node` is a normal npm package that ships its build output in `dist/`
(committed). Consumers depend on a packed tarball:

```jsonc
// txnet-backend/package.json, site-pwa/package.json
"@txnet/locale-client": "file:./vendor/locale-client.tgz"
```

A tarball (not a `file:<dir>` symlink) is used deliberately — it extracts into
`node_modules/` as a plain package, so turbopack, webpack, Nx and `tsc` all
resolve it with **zero** per-consumer config. For Next.js it is listed in
`serverExternalPackages` alongside `@grpc/grpc-js` / `@grpc/proto-loader`.

To ship a change to the Node client:

```sh
cd i18n-platform && make sync-node        # build dist/, npm pack, copy tgz to every consumer
#   ...or, on a box without make:  sh scripts/sync-node.sh
cd ../txnet-backend && npm install        # pick up the new tarball (repeat for site-pwa)
```

## Regenerating the gRPC stubs

Needs `protoc`, `protoc-gen-go`, `protoc-gen-go-grpc`:

```sh
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
cd i18n-platform && make proto      # regenerates services/locale-service + clients/go stubs
```

When the contract changes, also hand-edit `clients/node/proto.ts` (Node loads the
proto from an inline string at runtime), then run `make sync-node`.

## Running locally

```sh
# 1. source of truth
cd i18n-platform && make run-service           # gRPC on :50051, serves ../locales

# 2. each service, pointed at it
LOCALE_SERVICE_ADDR=localhost:50051 LOCALE_SCOPE=backend  ... auth-handler / auth-service
LOCALE_SERVICE_ADDR=localhost:50051 LOCALE_SCOPE=frontend ... site-pwa
```

In `dev-docker/docker-compose.main.yml` the `locale-service` container mounts
`../locales:/locales:ro` and every consumer gets `LOCALE_SERVICE_ADDR=locale-service:50051`.

## Contract summary (`proto/locale/v1/locale.proto`)

| RPC | Kind | Use |
|---|---|---|
| `GetSnapshot(lang, scope)` | unary | blocking boot |
| `GetAvailableLocales()` | unary | language list + metadata |
| `Watch(langs, scope)` | server-stream | live reload — a full snapshot per change |

`scope` is `backend` / `frontend` / `""`. A named scope is always returned merged
with the `shareds` namespaces. `""` returns every scope with namespace keys
prefixed `"<scope>/"`. Snapshot keys are flat dot-notation; the Node adapters
re-nest them where a tree is expected.

### Which languages a client loads

Every client loads **all** languages `locale-service` advertises — there is no
per-language config. On boot it calls `GetAvailableLocales`, `GetSnapshot`s each
one, then `Watch`es with an empty `langs` filter, so a language added to
`locales/` later is picked up automatically. Pass an explicit language list to
the client constructor only if you deliberately want to restrict it.
`DEFAULT_LANGUAGE` is just the fallback used when a key or language is missing.

## On-disk layout it reads (`../locales`)

```
locales/backend/langs/<lang>/<namespace>.json
locales/frontend/langs/<lang>/<namespace>.json
locales/shareds/<lang>/<namespace>.json
locales/<scope>/langs/<lang>/metadata.json   # reserved — locale metadata, not a namespace
```
