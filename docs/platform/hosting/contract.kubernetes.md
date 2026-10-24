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
(`K3S_IMAGE`, `TRAEFIK_CRD_VERSION`). Server flags in `k8s/k3s/config.yaml`:
`disable: [traefik]` (ours, K9), `secrets-encryption` (S6); `servicelb`, `local-path` on. Namespace `txnet` for the
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
so a shell `$(date)` survives. A value a command needs (Redis's
`--requirepass`) is an environment variable its shell reads, never compose
interpolation into `command` or a healthcheck, which would print it in the pod
spec (OPS-1-o-i). The Secret's name carries a hash of its data,
as Kustomize's generators do, so a changed value rolls the pod.
The values come from SOPS files encrypted to an age key (user, 2026-10-24,
ADR-0164): `.env.prod` and `dev-docker/secrets/*` committed encrypted, decrypted
only in memory by `prod.k8s.sh render` on the node. The age key lives on the
node outside the checkout, rides in the bundle (B5) and is kept off the server
beside the bundle's passphrase; k3s stores Secrets encrypted
(`--secrets-encryption`). Rules S1–S7 in `contract.secrets.md` (OPS-1-o-j).

**K6 — Probes from H15.** A compose `healthcheck` becomes the same command as
an `exec` probe (`CMD-SHELL` -> `sh -c`): `readinessProbe` and `livenessProbe`
with compose's interval, timeout and retries; a `startupProbe` with
`failureThreshold = ceil(start_period / interval) + retries` holds both off for
the start period and the misses compose still allows after it — the start period
alone gave `main-db` one probe, and a first `initdb` was killed (OPS-1-o-d).
With no start period both wait `initialDelaySeconds = interval`, as Docker's
first check does: a probe at t=0 wrote RabbitMQ's Erlang cookie into its empty
claim as root before the server could (OPS-1-o-i). Every container has one (H15, H24). A sidecar (`pg-backup`) gets
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
- A bound directory is Docker's own state (`/var/run/docker.sock`,
  `/var/lib/docker/containers`), dropped, or baked into the image (K8); else the render
  fails, as an anonymous volume does: source trees are `docker-compose.dev.yml`'s (OPS-1-o-v).
- `tmpfs` and `shm_size` are `emptyDir` with `medium: Memory`.

**K8 — Images.** Every compose service with `build:` is built with its compose
build section and `ENVIRONMENT=prod`, and tagged
`${LOCAL_DOCKER_REGISTRY}/txnet/<service>:${IMAGE_TAG}`; a pulled image keeps
its compose `image:`. Two directories are baked in instead of mounted:
`locales/` into `locale-service` (36 MB, past a ConfigMap's 1 MiB), and
Traefik's `dynamic/`, `plugins-local/` and `origin-pull/` into
`dev-docker/traefik/Dockerfile`'s image (`gateway-handler`'s `build:`, so pushed as
`txnet/gateway-handler` by the rule above; dev still mounts the three over it);
`locales/` arrives as the compose build context `locales`. Migrations run as Job
`db-migrate` (`prisma migrate deploy --schema prisma/domains`) from the
backend Dockerfile's `dependencies` stage, before any Deployment is applied.
It is the compose service `db-migrate` (`dev-docker/compose/db-migrate.yml`,
profile `migrate`, `restart: "no"`); the renderer makes any run-once service a
Job (`backoffLimit: 0`) written to `<base>/jobs/`, outside the base, and reads
the `migrate` profile (`tables.py` STACKS).
A prod image runs with no source mount, so it holds what it runs: the backend
`prod` stage is `dist/<app>/` beside the workspace's production `node_modules`,
pruned once in a shared `prod-deps` stage (Prisma's generated client and
argon2's native build kept); `APP_NAME` is declared after the shared stages, so
the eleven apps share one install. A Go image's `WORKDIR` is its compose
`working_dir`, where dev mounts the source.

**K9 — Traefik.** Our Traefik (`gateway-handler`'s image, K8) runs as a Deployment behind a
`LoadBalancer` Service on 80/443 (k3s `servicelb`). `--providers.docker*`
becomes `--providers.kubernetescrd` (namespaces `txnet`, `txnet-monitoring`, as service account
`traefik-ingress-controller`) with `--providers.file` kept for the
baked `dynamic/`. Each `traefik.http.routers.<r>.*` label set is one
`IngressRoute` `<r>` (`match` = rule, `priority`, `entryPoints`,
`middlewares`, `tls.certResolver`, the service port from the
`loadbalancer.server.port` label); each `traefik.http.middlewares.<m>.*` set is
one `Middleware` `<m>`; `@file` references stay as they are. Only containers with
`traefik.enable=true` count, as with `exposedbydefault=false`. A router naming no
service takes its container's one; the backend's ClusterIP Service gains that
port (K4), and a ForwardAuth address is checked like any K4 call. Basic-auth users
go to a hashed Secret, the only form the CRD takes. A label the renderer has no
mapping for fails the render (K2). Compose prints a literal `$` as `$$`; the
renderer undoes that once, for every value, before K5's own escaping. Traefik's CRDs and
RBAC are vendored at `TRAEFIK_CRD_VERSION` under `k8s/traefik/`. ACME storage
is claim `letsencrypt`. The Service is `externalTrafficPolicy: Local`, so
Traefik sees the connecting address, not the node's (O5, O7). On a k3s host O7's chain is reached from `FORWARD`
(`--ctorigdstport 80|443`) where Docker's host used `DOCKER-USER` (OPS-1-o-g).

## Deploying

**K10 — `scripts/prod.k8s.sh build|push|render|deploy|smoke|rollback`.** `build` builds one
service at a time (`k8s_render.py --images` lists them) and tags each for the
registry. `deploy` renders into `k8s/base/` and `k8s/monitoring/base/` (git-ignored,
K11), applies `k8s/traefik` and waits for its CRDs, applies all but the Deployments
and DaemonSets (`tools/k8s_manifest.py stores`), waits on the StatefulSets, runs
`db-migrate` to completion, applies the overlay
(`kubectl kustomize k8s/overlays/<env>`), then waits on
`kubectl rollout status --timeout=300s` for every workload; one not ready
sets the release back (K16; on the first release, the failed ones are
`rollout undo`ne). Only after every rollout is ready and the smoke check passed
does a last apply `--prune -l app.kubernetes.io/part-of=txnet`, so a pod set back
still finds the hashed Secrets it names; `--prune-allowlist` never names a
claim, a Namespace, a CRD or a Job. Overlays: `prod` (both bases, `k8s/traefik`,
`k8s/monitoring`); `rehearsal` lands with K12 (OPS-1-o-f).

**K11 — Monitoring.** `docker-compose.sys-monitor.yml` is rendered the same
way (`k8s_render.py --stack monitoring`, `tables.py` STACKS; env files `.env`,
`.env.prod`, `dev-docker/monitoring/.env.prod`) into `txnet-monitoring`, plus
`k8s/monitoring/` (the accounts of the two pods that read the API). A compose
`configs:`/`secrets:` entry is a ConfigMap/Secret at its target, the rule files
byte for byte. The stack publishes nothing (user, 2026-10-24): a ClusterIP
from `expose:`, `kubectl port-forward` for an operator, Grafana through Traefik.
A name the main stack serves (`rabbitmq`, `main-db`, …) is an ExternalName
Service, so Prometheus scrapes by the same names, each target checked as K4
checks a call. Promtail is a DaemonSet on `/var/log/pods` (pod label
`txnet.io/logging: "true"`; `service` = the container; the CRI frame read
before H13's `level`), offsets in `/var/lib/txnet/promtail`. cAdvisor is not
rendered (user, 2026-10-24): Prometheus reads each kubelet's `/metrics/cadvisor`,
TLS verified. Prometheus, Loki, Grafana are StatefulSets (K3). The node sets
`fs.inotify.max_user_instances=512` at install (OPS-1-o-f): at 128 Promtail
exited "too many open files". Proven 2026-10-24 in a throwaway k3s: every
target up, two of them across namespaces; Loki held the labelled pod's lines
with `level`, none of the unlabelled one's.

## The rehearsal

**K12 — The rehearsal on the test server** (ADR-0163, amending ADR-0147
point 6). `scripts/k8s-rehearse.sh up|deploy|check|down`: k3s from `K3S_IMAGE`
on the host itself, beside Docker, the compose stack stopped for it, overlay
`rehearsal` (the test server's env files, no ACME), images pulled as K14 says,
one replica each (K19). `check` proves the row: every workload ready, a
rolling update of `billing-service` under a request loop with zero failed
requests, the three data stores' pods deleted and back with their rows, keys
and queued messages and `pg-backup.sh drill` passing in `main-db`'s, a bundle restored
(OPS-1-o-k). The cluster that passes is the one OPS-1-p cuts over to; `down`
removes k3s and brings compose back, only when the rehearsal is abandoned.

**K13 — k3s's own ports.** The API server (6443), the kubelet (10250),
kube-proxy's health (10256), flannel (8472/udp) and every NodePort
(30000–32767, which a LoadBalancer Service also gets) answer from localhost and
the node only, never the public address; only 80/443 are reached from outside,
through O7 (K9). `scripts/edge/k3s_ports.py apply` drops them on the public
interface in chain `TXNET-K3S` (INPUT; FORWARD by `--ctorigdstport` for a
NodePort), jumps kept on top as O7's are — another `TXNET-*` chain's jumps are
not fought over. `install` runs it before `k3s.service` at boot and every 5
minutes; in place before k3s is installed (OPS-1-o-l). Proven 2026-10-24 in empty
network namespaces: from outside each port timed out and a NodePort DNATed to a
stand-in pod too, while 9090 DNATed and 9999 still answered; the node reached
6443/8472 on localhost and its public address; an `ACCEPT` above ours held
until the next `apply`; `remove` reopened them. Tests: `test_k3s_ports.py`.

**K14 — The node pulls; it does not build.** K8's images are built off the node
and pushed; it pulls with a sealed pull-only login. Rules R1–R4 in `contract.release.md` (OPS-1-o-m).

## Surviving and growing (ADR-0164)

**K15 — Backups off the node.** pgBackRest gains `repo2` on S3 beside the host
path: WAL is archived to both, a full and diffs to both (H3's schedule). The
bucket has object lock in compliance mode for 30 days (user, 2026-10-24), so a key
that can list and expire still cannot destroy what is locked (OPS-1-o-o). The
bundle (B6, B7) is unchanged and remains the restore of everything else.

**K16 — A release is one unit.** Smoke-checked after `deploy`, and set back
whole, never `db-migrate`. Rules R5–R9 in `contract.release.md` (OPS-1-o-p).

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

**K19 — The memory fit** (OPS-1-o-n). Each workload's compose file sets
`mem_reservation`, its request (measured peak + headroom), and `mem_limit`, its
ceiling: a limit alone is requested whole, and the ceilings (19.6 GB) fit no node.
`tools/k8s_memfit.py report` holds requests + host + k3s (789 + 456 + 7.5/pod MiB)
under the test server's 11,959 MiB: 9,236 on 2026-10-24, translators in; `sample`
re-measures, a peak over its request fails. Short, `translator-llm` goes to zero
first (drafts fall back to LibreTranslate), then `translator`.
