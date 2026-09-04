---
id: ops-observability
status: active
updated: 2026-09-04
---

# Observability

Kept as **separate stacks** from the app so they can scale and restart
independently (and, in Swarm, run global-mode agents on every node).

## Monitoring stack (`dev-docker/monitoring/`)

| Component | Port (dev) | Role |
|---|---|---|
| Prometheus | 9091 | metrics scrape + alert rules |
| Grafana | 3001 | dashboards |
| Loki | 3101 | log aggregation |
| Promtail | — | ships container logs (labelled `txnet.logging=true`) to Loki; `deploy.mode: global` in Swarm |
| node-exporter | — | host metrics; global |
| cAdvisor | 8080 | container metrics; global |
| Alertmanager | 9094 | routes alerts (config incl. a `bale_token.txt` for Bale notifications) |

Config lives in `dev-docker/monitoring/config-dev/` (`prometheus.yml`,
`promtail.yaml`, `alertmanager.yml`). Swarm expects
`config-${ENV_NAME}/prometheus.yml` + secret files present on the manager.

## Error tracking

Glitchtip (Sentry-compatible) as its own stack (`dev-docker/bug-tracker/`,
project `txnet-bugtracker`) at `sentry-dev.<domain>`. No service SDK is wired up
in code yet — integration is pending.

## App logs

Services log to stdout (NestJS `Logger`, Go `slog`). The i18n exception filter
logs the real error server-side only, correlated by a `ref` id returned to the
client. Compose caps json-file logs at 10m x 3.

## Gaps

- No metrics endpoint exposed by auth-service / auth-handler / locale-service yet
  (Prometheus has nothing app-level to scrape).
- No SLOs defined (`slo.md` not written).
- No alert runbooks (`runbook-*.md` not written).
