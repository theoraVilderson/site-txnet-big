---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: a release, from its images to its way back

The build spec for K14 (ADR-0163 point 4, OPS-1-o-m) and K16 (ADR-0164
point 2, OPS-1-o-p). The node runs the platform; it never builds it. On
2026-10-23 a build on the test server, during the restore, starved the services
it was restoring. A release is one commit, and it goes back as one.

## TL;DR
Build and push off the node (`prod.k8s.sh build`, `push`); on the node,
`prod.k8s.sh registries` writes `/etc/rancher/k3s/registries.yaml` from the
sealed `.env.prod`, and containerd pulls with that pull-only login. `deploy`
then smoke-checks the release, and on any failure renders the commit before it
again and sets every workload back to it; `rollback [tag]` does that by hand.

## Where the images come from

**R1 — The node pulls with a pull-only login, kept sealed.**
`LOCAL_DOCKER_REGISTRY_PULL_USER` / `_PASSWORD` are in `.env.prod`, so S1 seals
them with no new file; no compose service names them, so no pod sees them (K5).
`registries.yaml` gives them for `${LOCAL_DOCKER_REGISTRY}`; containerd sends
them on every pull, so no pod spec carries an `imagePullSecrets`. The login can
read, never push: a node that is taken over cannot replace an image another
node will run. The push login stays where `push` runs.

**R2 — `prod.k8s.sh registries` writes the file.** It opens the sealed secrets
in `/dev/shm` (S4), renders with `k8s_render.py --registries`
(`k8srender/registries.py`), and moves the result into `$K3S_ETC` (default
`/etc/rancher/k3s`) 0600. A variable missing fails it, naming the variable:
with no login the node pulls nothing of ours and says so only pod by pod.
containerd reads the file when k3s starts, so OPS-1-o-f writes it before
installing k3s, as it copies `k8s/k3s/config.yaml` (S6); after a change,
`systemctl restart k3s`.

**R3 — Docker Hub through the mirror.** The same file mirrors `docker.io` to
`https://${DOCKER_REGISTRY}`: k3s's own images (pause, coredns, local-path)
name `docker.io`, which the node reaches only through the mirror every compose
`image:` already names.

**R4 — The node never builds.** `prod.k8s.sh build` refuses when `$K3S_ETC`
exists. A release is `build` and `push` off the node, at the commit `deploy`
then runs on it: both take `IMAGE_TAG` from the commit (K16).

## A release and its way back

**R5 — A release is a commit.** `IMAGE_TAG` is HEAD's 12-character hash, and
`deploy` refuses any other tag or a checkout `git status` shows changed: a
rollback renders the commit again, so what is deployed must be what was committed.

**R6 — The smoke check** (`tools/k8s_release.py smoke`), once every rollout is
ready. Each running container's readiness probe (a sidecar's liveness) by
`kubectl exec`; then one request per IngressRoute through a `port-forward` to
Traefik's pod: its first `Host` (else `api.${DOMAIN_NAME}`, which only `/api/bot`
names — on the apex coinsite's longer rule would win), first `PathPrefix`/`Path`
and `Method`, on `websecure` when listed, presenting the origin-pull client pair
as Cloudflare does (O3; sealed by S1). Any status 1–499 passes: a 401 or 404 came
from the backend. A workload at zero replicas, and a route to one, is not asked.

**R7 — A failure sets every workload back.** A rollout not ready in K10's
300s, or a failed smoke check, renders the release before it from a `git
worktree` of its commit, with today's sealed secrets (user, 2026-10-24: a rotated
password stays rotated), applies it in K10's order without `db-migrate` (C-39
keeps the previous release correct on the new schema), smoke-checks it, prunes,
and fails the deploy. The prune waits for the smoke check, so the previous
release's hashed Secrets still exist while it comes back. The first release has
nothing before it: K10's undo of each failed workload. A rollback that fails too
stops there and says so; it never loops.

**R8 — The record.** ConfigMap `txnet-release` in `txnet`: `history` (the last
ten tags, the running one last) and `overlay`. It carries no `part-of` label,
so no prune removes it. A deploy appends its tag; a rollback to a tag drops
every tag after it, so the next `rollback` goes further back, never forward.

**R9 — `prod.k8s.sh rollback [tag]`** by hand: R7's path to `tag`, by default
the release before the one running, with the recorded overlay. A secret file
only the old commit mounts is not sealed today, and fails its render (S4).

## The real login (OPS-1-o-f, with the user)

A pull-only token on the registry, made by the user; put in `.env.prod` on the
test server, `secrets seal .env.prod`, `prod.k8s.sh registries`, then k3s.

## Proof

2026-10-24, in a throwaway k3s on the dev host, with the dev host's push login
standing in for the pull-only one: a 2 MB image pushed as `txnet/k14-proof:t1`;
`ctr images pull` with no login refused ("no basic auth credentials"); a pod
from it pulled through `registries.yaml` and ran; coredns and local-path came
from `docker.io` through the mirror. The tag was deleted after. Tests:
`tools/k8s_deploy_test.py` `RegistriesTest`, `test_build_refuses_on_a_k3s_node`.

R5–R9, 2026-10-24: `tools/k8s_release_test.py` — the probe and route plans,
every one of the production model's IngressRoutes given a request, the record,
and `deploy`/`rollback` driven with a fake `kubectl` (a release not ready or
failing its check rendered back from the earlier commit's worktree, `db-migrate`
not run again, one prune and only after it). Not yet run against a cluster: the
first is the rehearsal (OPS-1-o-f).
