# TXNet — Local Development Docker Environment

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SHARED DOCKER NETWORKS                       │
│                                                                     │
│  public_gateway_network (bridge)  ←── external traffic (ports 80/443)
│  private_backend_network (bridge) ←── all inter-service communication
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   INDEPENDENT #1     │  │  INDEPENDENT #2  │  │  INDEPENDENT #3  │
│   sys-monitor        │  │  bug-tracker     │  │  registry        │
│                      │  │                  │  │                  │
│  Prometheus :9091    │  │  Glitchtip :8000 │  │  Registry :5000  │
│  Grafana    :3001    │  │  Postgres (own)  │  │                  │
│  Loki       :3101    │  │  Redis    (own)  │  │                  │
│  Promtail           │  │  Worker          │  │                  │
│  Node Exporter      │  │                  │  │                  │
│  cAdvisor   :8080    │  │                  │  │                  │
│  Alertmanager:9094   │  │                  │  │                  │
│                      │  │                  │  │                  │
│  Project: txnet-     │  │  Project: txnet- │  │  Project: txnet- │
│           monitor    │  │           bug-   │  │           registry│
│                      │  │           tracker│  │                  │
└──────────┬───────────┘  └────────┬─────────┘  └────────┬─────────┘
           │                       │                     │
           └───────────────────────┼─────────────────────┘
                                   │
                    private_backend_network
                                   │
┌──────────────────────────────────┼─────────────────────────────────┐
│                          MAIN APPLICATION STACK                     │
│                          Project: txnet-main                        │
│                                                                     │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐    │
│  │ Traefik v3.7 │   │ Go Auth Handler  │   │ NestJS Backends  │    │
│  │ :80 / :443   │──▶│ ForwardAuth      │──▶│ auth-service:3000│    │
│  │ TLS + Routes │   │ :8080            │   │ billing-svc:3000 │    │
│  └──────────────┘   └──────────────────┘   └──────────────────┘    │
│                                                                     │
│  ┌──────────────┐   ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │ coinsite     │   │ site-pwa │ │ Redis    │ │ PostgreSQL   │    │
│  │ Next.js:8080 │   │ Next.js  │ │ :6379    │ │ :5432        │    │
│  │ (main page)  │   │ :8181    │ └──────────┘ └──────────────┘    │
│  └──────────────┘   │ (panel)  │                                    │
│                     └──────────┘                                    │
│  ┌──────────────┐                                                   │
│  │ RabbitMQ     │                                                   │
│  │ :5672 :15672 │                                                   │
│  └──────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
dev-docker/
├── dev-setup.sh                          # Master control script
├── docker-compose.main.yml               # Main application stack
├── monitoring/
│   ├── docker-compose.sys-monitor.yml    # Prometheus + Grafana + Loki stack
│   ├── .env.dev                          # Monitoring env vars
│   └── config-dev/
│       ├── prometheus.yml
│       ├── promtail.yaml
│       ├── alertmanager.yml
│       └── bale_token.txt
├── bug-tracker/
│   ├── docker-compose.bug-tracker.yml    # Glitchtip (Sentry alternative)
│   └── .env.dev                          # Bug tracker env vars
└── registry/
    ├── docker-compose.registry.yml       # Private Docker registry
    └── .env                              # Registry env vars
```

## Quick Start

### 1. Create your `.env` file

```bash
# From the project root:
cp .env.example .env
# Edit .env with your actual values (passwords, secrets, domain, etc.)
```

### 2. Start everything

```bash
cd dev-docker
./dev-setup.sh up
```

This will:

1. Create shared Docker networks (`public_gateway_network`, `private_backend_network`)
2. Start independent services (registry → monitoring → bug-tracker)
3. Start the main application stack

### 3. Verify

```bash
./dev-setup.sh status
```

## Manual Control (per-stack)

If you need to manage stacks individually:

```bash
# ---- Independent Services (order doesn't matter) ----

# Registry
cd dev-docker/registry
docker compose --env-file .env -p txnet-registry -f docker-compose.registry.yml up -d

# System Monitor
cd dev-docker/monitoring
docker compose --env-file .env.dev -p txnet-monitor -f docker-compose.sys-monitor.yml up -d

# Bug Tracker
cd dev-docker/bug-tracker
docker compose --env-file .env.dev -p txnet-bugtracker -f docker-compose.bug-tracker.yml up -d

# ---- Main Stack (start LAST) ----
cd /root/site-txnet-big
docker compose --env-file .env -p txnet-main -f dev-docker/docker-compose.main.yml up -d --build
```

## Service URLs

| Service           | URL                                                     |
| ----------------- | ------------------------------------------------------- |
| Coinsite (main)   | `https://txnet.cyou` / `https://www.txnet.cyou`         |
| Panel (site-pwa)  | `https://panel.txnet.cyou`                              |
| API (auth)        | `https://api.txnet.cyou/api/auth`                       |
| API (billing)     | `https://api.txnet.cyou/api/billing`                    |
| Traefik Dashboard | `https://monitor.txnet.cyou/dashboard/`                 |
| RabbitMQ Admin    | `https://mq.txnet.cyou`                                 |
| Grafana           | `http://localhost:3001` or `https://grafana.txnet.cyou` |
| Prometheus        | `http://localhost:9091`                                 |
| Glitchtip         | `https://sentry-dev.txnet.cyou`                         |
| Docker Registry   | `https://registry.txnet.cyou`                           |

## Key Design Decisions

1. **Strict separation**: Independent services (`sys-monitor`, `bug-tracker`, `registry`) use their own compose projects (`txnet-monitor`, `txnet-bugtracker`, `txnet-registry`). Restarting the main stack (`txnet-main`) never touches them.

2. **Shared network**: All stacks connect to `private_backend_network` (external). Traefik in the main stack can discover and route to services in other stacks via Docker's DNS-based service discovery.

3. **No Swarm**: All `deploy` sections from the original `compose.yml` have been removed. This is pure `docker compose` for local development.

4. **Let's Encrypt staging**: The main Traefik uses the Let's Encrypt **staging** server to avoid rate limits during development. Switch to production by removing the `caServer` line in `docker-compose.main.yml`.

5. **Hot-reload**: Source code is mounted with `:delegated` for the Go auth-handler, NestJS services, and Next.js frontends.

## Stopping

```bash
./dev-setup.sh down     # Stop everything
./dev-setup.sh restart  # Restart everything
```
