---
id: ops-environments
status: active
updated: 2026-09-04
---

# Environments

## Env files (loaded in order, later wins)

| File | Role | Committed? |
|---|---|---|
| `.env` | shared — identical in every environment | values yes, secrets no |
| `.env.dev` | dev overrides | yes (dev-only secrets) |
| `.env.prod` | prod overrides | no (real secrets) |
| `.env.example` | annotated template for all three blocks | yes |

`scripts/dev.compose.sh` -> `--env-file .env --env-file .env.dev -p devtxnet`.
`scripts/prod.compose.sh` -> `--env-file .env --env-file .env.prod -p prodtxnet`.
Different project name + `STACK_NAME` + network names + host ports, so dev and
prod can run on one host at once. `dev-docker/dev-setup.sh` orchestrates the
main stack + the three independent stacks.

## Stacks

| Stack | Compose file | Project | Contents |
|---|---|---|---|
| main | `dev-docker/docker-compose.main.yml` | `txnet-main` / `devtxnet` / `prodtxnet` | Traefik, locale-service, auth-handler, auth-service, billing-service, site-pwa, coinsite, Postgres, Redis, RabbitMQ |
| monitoring | `dev-docker/monitoring/docker-compose.sys-monitor.yml` | `txnet-monitor` | Prometheus, Grafana, Loki, Promtail, node-exporter, cAdvisor, Alertmanager |
| bug-tracker | `dev-docker/bug-tracker/docker-compose.bug-tracker.yml` | `txnet-bugtracker` | Glitchtip (+ own Postgres/Redis/worker) |
| registry | `dev-docker/registry/docker-compose.registry.yml` | `txnet-registry` | private Docker registry |
| prod (swarm) | `swarm/docker-stack.yml` (+ compose) | `txnet` | Swarm overlay: `deploy` sections, global `promtail` |

Networks: `public_gateway_network`, `private_backend_network` (shared/external so
Traefik in the main stack can route to the other stacks).

## Routing (Traefik)

| Host | Service |
|---|---|
| `<domain>` / `www.<domain>` | coinsite (marketing-web) |
| `panel.<domain>` | site-pwa (panel-web) |
| `api.<domain>/api/auth` | auth-service |
| `api.<domain>/api/billing` | billing-service (behind `strip-fake-headers` + `my-auth` ForwardAuth) |
| `monitor.<domain>` | Traefik dashboard (basic-auth) |
| `mq.<domain>` | RabbitMQ management |

## Config keys that MUST agree across services

- `JWT_ACCESS_SECRET` == `JWT_SECRET` (auth-service, auth-handler, site-pwa).
- `REDIS_KEY_NAMESPACE` + `REDIS_KEYSPACE_VERSION` (auth-service, auth-handler) —
  see `platform/redis-keyspace`.
- `LOCALE_SERVICE_ADDR` = `locale-service:50051`; `LOCALE_SCOPE` = `backend` for
  services, `frontend` for site-pwa.
- `DEFAULT_LANGUAGE` = `fa`.

## Secret ownership

See `security/threat-model.md` "Secrets". All secrets currently live in
`.env.*`; there is no secrets manager / Docker secret wired up yet.
