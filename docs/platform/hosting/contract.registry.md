---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: where the k3s node gets its images

The build spec for K14 (ADR-0163 point 4, OPS-1-o-m). The node runs the
platform; it never builds it. On 2026-10-23 a build on the test server, during
the restore, starved the services it was restoring.

## TL;DR
Build and push off the node (`prod.k8s.sh build`, `push`); on the node,
`prod.k8s.sh registries` writes `/etc/rancher/k3s/registries.yaml` from the
sealed `.env.prod`, and containerd pulls with that pull-only login.

## Rules

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
