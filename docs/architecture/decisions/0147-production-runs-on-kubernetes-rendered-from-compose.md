---
id: adr-0147
status: active
updated: 2026-10-14
---

# ADR 0147 — Production runs on Kubernetes (k3s), rendered from the compose files

- **Status:** accepted
- **Date:** 2026-10-14
- **Decision:** the user's (2026-10-14: "I don't want Swarm at all any more, I
  want Kubernetes")
- **Affects units:** hosting
- **Amends:** ADR-0126 point 7 (Swarm on one node) and its rejection of
  Kubernetes. ADR-0022/0026's "Swarm secret" KEK becomes a Kubernetes Secret
  mounted at the same file path: `VAULT_KEK_FILE` and the envelope are unchanged.

## Context

ADR-0126 chose Docker Swarm for production because there was one server and
Swarm reads compose files. Nothing of it was built: `swarm/docker-stack.yml` is
a stub, and OPS-1-o was the row to write it. The user wants the platform on
Kubernetes instead, so that growing to more servers (OPS-1-y's standby, more
tenants) is adding a node, not changing orchestrators a second time.

Two facts constrain the move today. There is **one server**, the dev host, and
it also runs the user's live site and bot — so nothing may change its network
or ports. There is **no production server** yet, and no second server for a
database standby.

The compose files hold every service's environment (~550 variables), routes
(~460 Traefik labels), volumes and healthchecks, and dev keeps running on them.

## Decision

1. **k3s** is the distribution: standard Kubernetes, one binary, one node today,
   `k3s agent` joins the next one. Its bundled Traefik is disabled; we run ours.
2. **The compose files stay the only home of a service's definition.**
   `tools/k8s_render.py` renders the production compose model (fully
   interpolated by `docker compose config`, so compose's own `${VAR:-default}`
   semantics apply) into a Kustomize base at deploy time. The base is a build
   output, never committed, so it cannot lag. What only Kubernetes has —
   rollout strategy, volume sizes, which service is stateful — is a table in
   the renderer, and per-environment differences are hand-written Kustomize
   overlays under `k8s/overlays/`.
3. **A service's environment is a per-service Secret**, holding exactly the
   variables its compose service lists — least privilege as today, and no
   value in a Deployment spec.
4. **Postgres stays our own image** (`txnet/postgres:18`, pgBackRest, OPS-1-a…e)
   as a StatefulSet; `pg-backup` becomes a sidecar in the same pod so the socket
   is shared as H3 requires. An operator (CloudNativePG) is reconsidered when the
   second server exists (OPS-1-y).
5. **Zero-downtime deploys** are `RollingUpdate` with `maxSurge: 1`,
   `maxUnavailable: 0` and a readiness probe from the compose healthcheck —
   the equivalent of Swarm's `start-first`. Data stores use `Recreate`.
6. **Proven on a throwaway k3d cluster** (k3s inside Docker) on the dev host,
   bound to no host port the live site uses, deleted after. k3s is never
   installed on the dev host by an agent.
7. `swarm/` is deleted once the rehearsal passes (C-21).

## Consequences

- Positive: the next server is `k3s agent`, not a migration. Standard tooling
  (`kubectl rollout`, probes, Secrets) instead of Swarm's thinner set.
- Positive: a variable or route added to compose reaches production with no
  second edit.
- Negative / accepted cost: directory bind mounts (the Traefik plugins, 36 MB of
  `locales/`) cannot be ConfigMaps; they are baked into images, so a locale
  file change in production is an image build.
- Negative / accepted cost: k8s-only settings live in a renderer table, one
  more place to learn. It is deleted the day dev moves to Kubernetes and the
  rendered manifests become the source.
- What this forecloses: running production from `scripts/prod.compose.sh`
  after the cutover (OPS-1-p).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Docker Swarm (ADR-0126 point 7) | the user's call: a second orchestrator change later is the larger cost |
| kubeadm | a full control plane for one node and one operator: certificates, CNI and upgrades by hand |
| Helm | a templating language for one deployment of one product; Kustomize is in `kubectl` |
| Hand-written manifests beside compose | every variable and route written twice (C-27) |
| CloudNativePG now | discards the drilled pgBackRest path (OPS-1-a…e) before there is a standby to gain |
| Dev on k3s now | changes the network of a host that serves the live site and bot |

## Revisit trigger

Dev moves to Kubernetes (the renderer is then deleted and the manifests become
the source), or a second server exists (point 4's operator question).
