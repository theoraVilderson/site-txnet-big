---
id: tech-stack
status: active
updated: 2026-09-04
---

# Tech stack

| Layer | Choice | Version | Why (or ADR link) |
|---|---|---|---|
| Node backend | NestJS | 11 | DI + module structure for auth-service |
| Node monorepo | Nx | 23 | one workspace, per-service builds (webpack) |
| ORM / schema | Prisma + `@prisma/client` | 6.19 | Postgres `multiSchema`, one schema per domain (ADR-0001) |
| Database | PostgreSQL | 18 | relational + `multiSchema` + planned RLS/partitioning |
| Cache / ephemeral state | Redis (ioredis) | 8.x server | sessions, OTP truth, rate limits (ADR-0007, redis-keyspace) |
| Password / OTP hashing | argon2id | 0.41 | login + OTP codes hashed at rest |
| Validation | zod | 3.23 | request schemas + env validation |
| Edge auth | Go net/http + custom HMAC JWT | Go 1.22 | tiny ForwardAuth binary, no JWT lib (ADR-0004) |
| i18n | Go gRPC service + grpc-js / grpc-go clients | grpc 1.6x / 1.12 | single source of truth, live reload (ADR-0003) |
| Frontend | Next.js (App Router) + React 19 + Tailwind 4 | Next 15 | `site-pwa` panel, `coinsite` landing |
| Reverse proxy | Traefik | v3.7 | TLS (Let's Encrypt), routing, ForwardAuth, rate limit |
| Broker | RabbitMQ | 4.2 | declared in compose; no code publishes/consumes yet |
| Orchestration | docker compose (dev) / Docker Swarm (prod) | — | `scripts/{dev,prod}.compose.sh` |
| Observability | Prometheus, Grafana, Loki, Promtail, cAdvisor, Alertmanager, Glitchtip | — | `dev-docker/monitoring`, separate stack |

## Constraints

- Iranian deployment: registry is `docker.arvancloud.ir`; object storage is
  ArvanCloud; SMS/bot providers are local (Bale, SMS panel). Agents must not
  propose services blocked from Iran.
- `locale-service` must be reachable on boot — consuming services block until the
  first snapshot is cached, then fail fast on timeout.
- Go client is consumed via `go.work` (dev) / `replace` (Docker); the Node client
  ships as a packed tarball `vendor/locale-client.tgz`. Do not add a second copy.
