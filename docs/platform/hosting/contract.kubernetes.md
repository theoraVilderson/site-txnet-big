---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: Kubernetes

The build spec for ADR-0147, ADR-0163 and ADR-0164 (OPS-1-o-a … -r). Every value here is decided; a
building session does not reopen one. H15's healthchecks and H3's shared socket
are inputs; nothing here changes what a service does once it is up.

## TL;DR
Production is k3s. The compose files stay the only home of a service's
definition; `tools/k8s_render.py` turns the production compose model into a
Kustomize base at deploy time, and `k8s/overlays/` holds what differs per
environment. A rollout starts the new pod and waits for its readiness probe
before stopping the old one.

## The cluster

**K1 — Distribution.** k3s, version pinned once in `k8s/versions.env`
(`K3S_IMAGE`, `TRAEFIK_CRD_VERSION`). Server flags: `--disable=traefik` (we run
ours, K9). `servicelb` and `local-path` stay on. Namespace `txnet` for the
platform, `txnet-monitoring` for K11. The node is the test server (ADR-0163).
An agent never installs k3s on the dev host (ADR-0147 point 6); the test
server's install is OPS-1-o-f's, with the user, after K13.

**K2 — The renderer.** `tools/k8s_render.py <out-dir>` reads
`docker compose -p txnet --env-file .env --env-file .env.prod
-f dev-docker/docker-compose.main.yml config --format json` with
`ENVIRONMENT=prod` — compose does the interpolation, so `${VAR:-default}`,
`${VAR:?}` and `$$` mean exactly what they mean today. It writes a Kustomize
base (`kustomization.yaml` + one file per service) and never a committed file:
the output is a build artifact like an image. A compose key it does not map is
an error naming the service and key, never a silent drop. Its k8s-only facts
(K3, K7) are tables at the top of the file; that is their one home.

## Workloads

**K3 — One workload per compose service.** `replicas: 1`, labels
`app.kubernetes.io/name: <service>`, `app.kubernetes.io/part-of: txnet`.
- The data stores `main-db`, `memory-data`, `rabbitmq` are StatefulSets: one
  pod, its volume claim, a stop before the start (two writers on one volume
  corrupt it).
- Everything else is a Deployment with `strategy: RollingUpdate`,
  `maxSurge: 1`, `maxUnavailable: 0`, `minReadySeconds: 10`,
  `progressDeadlineSeconds: 300`, `revisionHistoryLimit: 3`.
- `pg-backup` is not a workload of its own: it is a second container in the
  `main-db` pod, and `pg_socket` an `emptyDir` both mount (H3). Its cron loop
  is unchanged.
- `restart: unless-stopped` is the pod default; `depends_on` is dropped — a
  pod that starts before its dependency fails its probe and is retried, which
  is what H15's DB ping is for.
- `stop_grace_period` -> `terminationGracePeriodSeconds` (compose's 10s when
  unset); `extra_hosts` -> `hostAliases`, Docker's `host-gateway` being the node's
  address the deploy passes (`--host-gateway`); `working_dir`, `entrypoint`,
  `command` -> `workingDir`, `command`, `args`; `container_name` is dropped.

**K4 — Services and names.** A compose service that others call declares the
ports in compose's own `expose:` list; the renderer makes a ClusterIP Service
of the same name with those ports. Every `host:port` and `//host` naming a
compose service in any rendered environment value must resolve to an
`expose:`d port, or the render fails — a call that would have died at run time
dies at render time instead.

**K5 — Environment.** A service's whole rendered `environment` is one Secret,
`<service>-env`, mounted with `envFrom` — exactly the variables its compose
service lists, as today, and no value in a pod spec. Kubernetes expands `$(X)`
in `env`, `command` and `args`; the renderer writes every literal `$(` as `$$(`
so a shell `$(date)` survives. The Secret's name carries a hash of its data,
as Kustomize's generators do, so a changed value rolls the pod.
The values come from SOPS files encrypted to an age key (user, 2026-10-24,
ADR-0164): `.env.prod` and `dev-docker/secrets/*` committed encrypted, decrypted
only in memory by `prod.k8s.sh render` on the node. The age key lives on the
node outside the checkout, rides in the bundle (B5) and is kept off the server
beside the bundle's passphrase; k3s stores Secrets encrypted
(`--secrets-encryption`). Rotation is `sops edit` then `deploy` (OPS-1-o-j).

**K6 — Probes from H15.** A compose `healthcheck` becomes the same command as
an `exec` probe (`CMD-SHELL` -> `sh -c`): `readinessProbe` and `livenessProbe`
with compose's interval, timeout and retries; a `startupProbe` with
`failureThreshold = ceil(start_period / interval)` holds both off for the start
period. Every container has one (H15, H24). A sidecar (`pg-backup`) gets
liveness and startup probes but no readiness probe, so its failure never takes
the pod out of its Service.

**K7 — Volumes.**
- A named volume is one PersistentVolumeClaim of the same name
  (`local-path`, `ReadWriteOnce`, size from the renderer's table, `1Gi` when
  unlisted); services that share it mount the same claim, which one node
  allows. A second node needs `ReadWriteMany` for `object_storage` and
  `locale_cache` — OPS-1-y's question, not this one.
- A host path (`PG_BACKUP_LOCAL_DIR`, `OBJECT_BACKUP_LOCAL_DIR`,
  `NODE_TEXTFILE_DIR`) is a `hostPath` of type `DirectoryOrCreate`.
- A bound file under `dev-docker/secrets/` is a Secret `secret-<file>` mounted
  read-only at the same path with `subPath`; any other bound file is a
  ConfigMap `cfg-<file>` the same way; both names hashed as in K5.
- A bound directory is either listed in the renderer's dev-only table (source
  trees, `node_modules`, `.next`, `/var/run/docker.sock`) and dropped, or
  baked into the image (K8). Anything else fails the render.
- `tmpfs` and `shm_size` are `emptyDir` with `medium: Memory`.

**K8 — Images.** Every compose service with `build:` is built with its compose
build section and `ENVIRONMENT=prod`, and tagged
`${LOCAL_DOCKER_REGISTRY}/txnet/<service>:${IMAGE_TAG}`; a pulled image keeps
its compose `image:`. Two directories are baked in instead of mounted:
`locales/` into `locale-service` (36 MB, past a ConfigMap's 1 MiB), and
Traefik's `dynamic/`, `plugins-local/` and `origin-pull/` into
`dev-docker/traefik/Dockerfile`'s `txnet/edge` image. Migrations run as Job
`db-migrate` (`prisma migrate deploy --schema prisma/domains`) from the
backend Dockerfile's `dependencies` stage, before any Deployment is applied.

**K9 — Traefik.** Our Traefik (`txnet/edge`, K8) runs as a Deployment behind a
`LoadBalancer` Service on 80/443 (k3s `servicelb`). `--providers.docker*`
becomes `--providers.kubernetescrd` with `--providers.file` kept for the
baked `dynamic/`. Each `traefik.http.routers.<r>.*` label set is one
`IngressRoute` `<r>` (`match` = rule, `priority`, `entryPoints`,
`middlewares`, `tls.certResolver`, the service port from the
`loadbalancer.server.port` label); each `traefik.http.middlewares.<m>.*` set is
one `Middleware` `<m>`; `@file` references stay as they are. Traefik's CRDs and
RBAC are vendored at `TRAEFIK_CRD_VERSION` under `k8s/traefik/`. ACME storage
is claim `letsencrypt`. The Service is `externalTrafficPolicy: Local`, so
Traefik sees the connecting address, not the node's (O5, O7). On a k3s host O7's chain is reached from `FORWARD`
(`--ctorigdstport 80|443`) where Docker's host used `DOCKER-USER` (OPS-1-o-g).

## Deploying

**K10 — `scripts/prod.k8s.sh build|push|render|deploy`.** `deploy` renders,
runs `db-migrate` to completion, applies the overlay
(`kubectl apply -k k8s/overlays/<env> --prune -l app.kubernetes.io/part-of=txnet`),
then waits on `kubectl rollout status --timeout=300s` for every workload; a
workload that does not become ready is `kubectl rollout undo`ne and the script
fails — Swarm's `failure_action: rollback`. Overlays: `prod`, `rehearsal`.

**K11 — Monitoring.** `docker-compose.sys-monitor.yml` is rendered the same
way into `txnet-monitoring`. Promtail runs as a DaemonSet reading
`/var/log/pods` (the `txnet.logging=true` label becomes the pod label
`txnet.io/logging: "true"`); Prometheus scrapes by Service DNS name.

## The rehearsal

**K12 — The rehearsal on the test server** (ADR-0163, amending ADR-0147
point 6). `scripts/k8s-rehearse.sh up|deploy|check|down`: k3s from `K3S_IMAGE`
on the host itself, beside Docker, the compose stack stopped for it, overlay
`rehearsal` (the test server's env files, no ACME), images pulled as K14 says,
replicas as OPS-1-o-n measured. `check` proves the row: every workload ready, a
rolling update of `billing-service` under a request loop with zero failed
requests, a `main-db` pod deleted and back with its data, a bundle restored
(OPS-1-o-k). The cluster that passes is the one OPS-1-p cuts over to; `down`
removes k3s and brings compose back, only when the rehearsal is abandoned.

**K13 — k3s's own ports.** The API server (6443), the kubelet (10250) and
flannel (8472/udp) answer from localhost and the node only, never the public
address; only 80/443 are reached from outside, through O7 (K9). In place
before k3s is installed (OPS-1-o-l).

**K14 — The node pulls; it does not build.** `/etc/rancher/k3s/registries.yaml`
names `${LOCAL_DOCKER_REGISTRY}` with a pull-only login, kept where OPS-1-o-j
puts secrets. K8's images are built off the node and `prod.k8s.sh push`ed
(OPS-1-o-m): a build on the node starves the running services.

## Surviving and growing (ADR-0164)

**K15 — Backups off the node.** pgBackRest gains `repo2` on S3 beside the host
path: WAL is archived to both, a full and diffs to both (H3's schedule). The
bucket has object lock in compliance mode for 30 days (user, 2026-10-24), so a key
that can list and expire still cannot destroy what is locked (OPS-1-o-o). The
bundle (B6, B7) is unchanged and remains the restore of everything else.

**K16 — A release is one unit.** `IMAGE_TAG` is the commit; `deploy` records
the previous tag. After every rollout is ready, `prod.k8s.sh smoke` asks each
service's health and one request per IngressRoute; a failure, or a rollout
not ready in K10's 300s, sets **every** workload of the release back to the
previous tag. `prod.k8s.sh rollback [tag]` does the same by hand. `db-migrate`
is never undone: C-39 keeps the previous release correct on the new schema
(OPS-1-o-p).

**K17 — A second node.** `k3s agent --server https://<node1>:6443` with the
token from a Secret; flannel `--flannel-backend=wireguard-native`, since node
traffic crosses the public network; K13 opens 6443, 10250 and 51820/udp to the
node addresses only. `main-db`, `memory-data`, `rabbitmq` are pinned by the node
label `txnet.io/data=true` (their `local-path` volume cannot follow them); the
LoadBalancer answers on both nodes, and Cloudflare reaches both (OPS-1-o-q).

**K18 — A move between servers.** With a second node: join it (K17), promote
Postgres's standby there (H22), stop and copy Redis and RabbitMQ, move the data
label, drain and remove the old node (OPS-1-o-r). Until then a move is a bundle
restored into a new cluster (OPS-1-o-k, B9).
