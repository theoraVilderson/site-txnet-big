---
id: ops-observability
status: active
updated: 2026-09-10
---

# Observability

Kept as **separate stacks** from the app so they can scale and restart
independently (and, in Swarm, run global-mode agents on every node).

## Monitoring stack (`dev-docker/monitoring/`)

| Component | Port (dev) | Role |
|---|---|---|
| Prometheus | 9091 | metrics scrape + alert rules (the rules arrived 2026-09-10, F-067-g — before that this row was aspirational) |
| Grafana | 3001 | dashboards |
| Loki | 3101 | log aggregation |
| Promtail | — | ships container logs (labelled `txnet.logging=true`) to Loki; `deploy.mode: global` in Swarm |
| node-exporter | — | host metrics; global |
| cAdvisor | 8080 | container metrics; global |
| postgres-exporter | — | the outbox gauge, and nothing else (F-067-c); default collectors off |
| Alertmanager | 9094 | routes alerts (config incl. a `bale_token.txt` for Bale notifications) |

Config lives in `dev-docker/monitoring/config-dev/` (`prometheus.yml`,
`promtail.yaml`, `alertmanager.yml`, `automation.rules.yml`), each mounted as a
compose `config`. Swarm expects `config-${ENV_NAME}/prometheus.yml` + secret
files present on the manager — see the gap on that below.

## Alert rules

`config-dev/automation.rules.yml` — the only rule file, and the first this
platform has had (F-067-g, 2026-09-10). Until it existed `prometheus.yml` had no
`rule_files:` key, so Alertmanager and its Bale receiver had been wired since
2026-09-04 with nothing able to fire into them.

Eight rules: five over the automation queue, three over the outbox (F-067-c).
What each one *means* is
`docs/domains/automation/contract.monitoring.md`; this file is how they are
wired.

**RabbitMQ is scraped by two jobs, not one.** The `rabbitmq_prometheus` plugin
is enabled in the `4.2-management-alpine` image already, and it serves two
different things on 15692. `/metrics` is aggregated — `rabbitmq_queue_messages_ready`
there is summed over every queue with no `queue` label at all, which cannot
answer "which queue is backing up". `/metrics/detailed` is per-object, and the
`rabbitmq-queues` job narrows it with `family=` to the two families that carry
the per-queue numbers, so the scrape grows with what is watched rather than with
the broker.

Neither job needs a published port: RabbitMQ and the monitoring stack share the
external `private_backend_network`, so 15692 is reachable in-network and stays
unreachable from outside it.

**Postgres is scraped for exactly one query (F-067-c).** The age of the oldest
unpublished `automation.outbox_event` row is a fact about a table — an
unpublished event has by definition never reached the broker — so it is the
first number here that cannot come off RabbitMQ. It comes from
`postgres-exporter` running `config-dev/postgres-queries.yaml`, with
`PG_EXPORTER_DISABLE_DEFAULT_METRICS` on: the built-in collectors are per-table
churn nobody is alerting on, and every one of them is 15 days of series.

It is an exporter rather than a `/metrics` on `worker-service` because ADR-0027
makes that process one that serves no requests — no port, no route, no Traefik
label. Adding an HTTP surface to expose one gauge gives back what the ADR
removed. The exporter connects as `txnet_app_user`, the RLS-enforced role, not
the owner: a monitoring container able to read every row of every table in
order to count one is a credential in the wrong place. Same network, no
published port, for the same reason as RabbitMQ.

Validate any change to either file before mounting it:

```bash
cd dev-docker/monitoring
docker run --rm --entrypoint promtool \
  -v "$PWD/config-dev/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$PWD/config-dev/automation.rules.yml:/etc/prometheus/automation.rules.yml:ro" \
  ${DOCKER_REGISTRY}/prom/prometheus:v2.53.0 check config /etc/prometheus/prometheus.yml
```

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
  (Prometheus has nothing app-level to scrape). No Node or Go Prometheus client
  is installed anywhere in the repo. Every number the automation alerts read
  came off the broker instead, which is why they could ship without one.
  Anything else only Postgres knows — the `automation.dead_letter` row count,
  for instance — now has a route: add a query to
  `config-dev/postgres-queries.yaml`, which F-067-c opened for the outbox age.
- No SLOs defined (`slo.md` not written).
- No alert runbooks (`runbook-*.md` not written). The automation rules
  carry their reasoning in their own `description` instead.
- **Prod has no monitoring stack of its own.** `swarm/docker-stack.yml` is 20
  lines and its only content is a `promtail` override set to `deploy.mode:
  global` — layered over `dev-docker/docker-compose.main.yml`, which does not
  define a `promtail` service at all. Promtail lives in the monitoring compose
  file, so that override is inert as written. `scripts/prod.compose.sh` never
  references the monitoring stack either.
- **`config-${ENV_NAME}/` templating does not exist.** `README.INFRA.md` and the
  stack table above both describe it, but `docker-compose.sys-monitor.yml`
  hardcodes `./config-dev/…`.
- **`README.INFRA.md` is stale.** It points repeatedly at a
  `monitoring-tower/sys-monitor/` directory that is not in the repo, and claims
  `deploy.mode: global` on promtail / node-exporter / cAdvisor, none of which
  carry a `deploy:` section.

The last three were found while shipping F-067-g and are **recorded, not
fixed**: making prod monitoring real is a deployment decision of its own size,
not part of wiring the dev alerts.
