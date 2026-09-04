---
id: dependency-graph
status: active
updated: 2026-09-04
---

# Dependency graph

Read this before any change: it defines **blast radius**.

## Generated (source of truth)

No static graph generator is wired up. For the Node backend, `npx nx graph`
(in `txnet-backend/`) shows project edges. Go modules: `go.work` at repo root +
`replace` directives in each `go.mod`. This section should be replaced with a
generated artifact if/when CI produces one.

## Runtime edges (manual — static analysis cannot see these)

| From | To | Transport | Sync/Async | Breaking if removed? |
|---|---|---|---|---|
| auth-service | locale-service | gRPC GetSnapshot + Watch | sync boot, async reload | yes — auth-service refuses to boot |
| auth-handler | locale-service | gRPC GetSnapshot + Watch | sync boot, async reload | yes — auth-handler exits non-zero |
| site-pwa (server) | locale-service | gRPC | sync boot | yes for SSR i18n |
| auth-service | Redis | ioredis | sync | yes — sessions/OTP/rate-limit |
| auth-handler | Redis | redis client | sync | yes — session-active check |
| auth-service | Postgres | Prisma | sync | yes |
| Traefik | auth-handler `/validate` | HTTP ForwardAuth | sync | protected routes fail closed |
| site-pwa | auth-service | HTTP proxy (`/api/auth/*`) | sync | panel auth screens break |
| auth-service, auth-handler | shared Redis keyspace prefix | convention (env) | — | mismatch = auth-handler can't see sessions |

## Consumer lookup

Consumers of unit X = every unit listing `X` in its front-matter `depends_on`.
Do not maintain a second hand-written list; derive it (or run
`python tools/docs-check.py`, which prints the reverse map).
