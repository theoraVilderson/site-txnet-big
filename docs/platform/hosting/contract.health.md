---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: the containers H15 does not cover

H15 checks the Nest services. This file checks every other container in the
main stack (OPS-1-aa), so every rollout waits on health (K6).
`tools/k8s_render_test.py` `RepoModelTest` renders the production model and
fails if any container has no probe. Rule H24.

## H24 — One check per kind of container

Each check asks whether *this* container does its job. A dependency's failure
belongs to that dependency's own check.

| container | check | why this one |
|---|---|---|
| `authorization-handler` | `wget` `127.0.0.1:${GATEWAY_PORT}/health`, `start_period` 90s | it listens only after the boot's wait for translations (`LOCALE_BOOT_TIMEOUT`, 60s) |
| `gateway-handler` (Traefik) | `traefik healthcheck --ping`, with `--ping=true` | `/ping` sits on the internal `traefik` entrypoint (:8080, never published); every router names its entrypoints, so none joins it |
| `site-pwa`, `coinsite` | H15's `http-health` with `HEALTH_PATH=/api/health` on `PORT` | `src/app/api/health/route.ts` is `force-static`: built once, so a check renders nothing and asks no session or tenant. `PORT` is the port Traefik's label calls, and the prod images listen there on `0.0.0.0` (OPS-1-o-s) |
| `guide-media` | `wget` `127.0.0.1:8082/healthz` | a loopback-only server in `guide-media.conf`, so the two servers that serve keys still answer nothing else |
| `mailpit` | `/mailpit readyz` | the image's own command |
| `pg-backup`, `object-backup` | `compose/health.yml` `loop-health` | see below |

**The backup loops.** Each pass of the loop (every 30s) touches `/tmp/healthy`.
A backup or drill touches `/tmp/busy` while it runs (`busy run …`). The check
passes when `/tmp/healthy` is under 120s old, or when a run is in progress and
under 12h old. 12h is half the daily schedule, so a run that would collide with
the next one fails first. A stale *backup* is not this check's job: that is
H5's and `ObjectBackupStale`'s alert on the textfile metrics.

**A sidecar is restarted, never taken out of service** (K6). A pod is ready
only when all its containers are. So `pg-backup`, a container in `main-db`'s
pod (K3), gets a liveness and a startup probe and no readiness probe. A
failing backup check restarts the backup and leaves the database's Service
alone.
