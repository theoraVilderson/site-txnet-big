---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-29
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

**R4 — Never built on the server node.** `prod.k8s.sh build` refuses where
`$K3S_ETC/k3s.yaml` exists: the control plane and every store run there, and the
2026-10-23 restore's build starved them. An agent builds, though release pods
run on it too (user, 2026-10-25: the dev host does both, and no build server is
bought); the build renices itself to `BUILD_NICENESS` and runs one image at a
time, so it yields to them. A release is `build` and `push` there, at the commit
`deploy` then runs, from a clean checkout (R12).

**R12 — An image is tagged by its source** (OPS-1-o-y). `k8srender/tags.py`
hashes, from git at HEAD so the node needs no npm or Nx: for an app of an Nx
workspace (`APP_NAME`, `nx.json` in the context) the workspace minus the
projects it does not import (`@scope/name` imports, `tsconfig.base.json` paths,
transitively) and minus `prisma/seed*.js`, which only db-migrate's stage runs;
for any other image what its Dockerfile `COPY`/`ADD`s, or the whole context
for `.`, a variable or a glob. Plus the Dockerfile, extra contexts and the
stage. Build args are left out: they name a mirror or a proxy and differ
between hosts. So a seed change rebuilds db-migrate alone, a billing change
billing alone, a `shared-core` or lockfile change every app. `build` skips a tag
the registry or this host holds, `push` one the registry holds, and `build` refuses
a checkout `git status` shows changed. "Holds" is asked with `docker buildx
imagetools inspect`, which reads the OCI manifest buildx pushes (`docker manifest
inspect` cannot, and called every tag absent — LIVE-1-ab); only `not found` is
absent, and a dropped request is asked again up to three times. The release is
still the commit (R5): a rollback renders an older commit with its own renderer, so a release made
before R12 comes back on its commit tags.

**R10 — The registry answers before anything is sent** (OPS-1-o-t). `push`
asks `https://<registry>/v2/` once (15s, `--noproxy`) before its first image, and
`registries` asks again from the node once the file is written. 200, or 401 asking
for the login, passes; anything else fails, naming the registry and the status: on
2026-10-24 the test server met 503/504 where the dev host met 401. A custom
domain answers only once it is in the CaaS ingress's `hosts` and in the CDN of the
same Arvan account; until then Arvan's edge finishes TLS and never answers.

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

**R11 — The login roles, every release** (OPS-1-o-w). After `db-migrate`, which
makes the group roles they join, and before the workloads, `scripts/db-login-roles.sh`
runs through `kubectl exec -i` into `main-db`, logged in as the pod's own
`POSTGRES_USER`; the three passwords are compose's reading of the opened env files
and reach psql on stdin, never an argv. A rollback runs it too: a rotated password stays rotated.

**R13 — Every release seeds** (OPS-1-o-x). `db-migrate` runs `prisma/seed.js`
after `migrate deploy`, with `DOMAIN_NAME`: an empty database has no platform
tenant, roles or `api.`/`panel.`/`sub.` doors, and auth-service does not start
without them (the rehearsal's first deploy, 2026-10-24). The same three doors are
made on `DOMESTIC_DOMAIN_NAME` when it is set (NIN-1-d2, ADR-0165 point 1;
`prisma/seed-platform-doors.js`), so either panel signs the same account in: both
doors are the platform tenant's, the refresh cookie is host-only and every `/api`
route matches by path. The seed is idempotent, so every release runs it; a door
already held is never moved. The owner's first password is the sealed
`dev-docker/secrets/platform-owner-password`, read through
`PLATFORM_OWNER_PASSWORD_FILE` and never printed, since a Job's output reaches
Loki (`prisma/seed-owner-password.js`); an empty file fails the Job. It opens
only the owner's setup (`setupRequired`, F-0102): the first sign-in sets the
owner's own username, password and phone before any session exists. With no file
set, as on the dev host, one is made and shown once.

**R8 — The record.** ConfigMap `txnet-release` in `txnet`: `history` (the last
ten tags, the running one last) and `overlay`. It carries no `part-of` label,
so no prune removes it. A deploy appends its tag; a rollback to a tag drops
every tag after it, so the next `rollback` goes further back, never forward.

**R9 — `prod.k8s.sh rollback [tag]`** by hand: R7's path to `tag`, by default
the release before the one running, with the recorded overlay. A secret file
only the old commit mounts is not sealed today, and fails its render (S4).

**R14 — A release passes the production twin first** (ADR-0166, OPS-1-ah).
Staging is k3s at `K3S_VERSION` in one privileged container, `txnet-staging`,
on the dev host: `scripts/staging.sh up|import|status|down`
(`tools/k8s_staging.py`). Its rules, each one held by the script:
- **No route out.** The container's only network is `--internal`; the local
  panels' containers (`/root/paneltest`) and the dev bots' gate (R18,
  `contract.scrub.md`) join it, and nothing else does. k3s
  exits "no default routes found" without one, so the default route is on the
  container's own link with no gateway behind it. `up` proves, before it
  returns, that the network is internal and `http://1.1.1.1` gets no answer;
  either failing removes staging. Proven 2026-10-29 from a pod: the internet
  "No route to host", outside DNS unanswered, the 3x-ui panel reached.
- **Production's server, nothing pulled.** `k8s/k3s/config.yaml` mounted as
  it is (K1). k3s's own images come from the release's air-gap archive,
  downloaded once per version and checked against the release's sum list on
  every `up`; ours are imported from the host's Docker (`import`, K14).
- **Memory is lent by the dev stack.** `up` stops it when running, records
  that, and refuses unless K19's requests plus k3s fit in what is then free;
  `down` starts it again only if `up` stopped it.
- **Nothing but images outlives `down`**: the container, its named volume
  `txnet-staging-k3s` and the network go, and the kubeconfig with them. A failed
  `up` prints the container's log, then does the same. containerd's store is its
  own volume, `txnet-staging-images` (OPS-1-ah-e, `tools/k8s_staging_images.py`):
  `down` first prunes images the running release does not use, deletes every
  namespace but k3s's own and removes their pods, containers and writable layers
  with them; it keeps the store only when crictl then lists none, else removes it.
  `up` counts it as part of the 17 GiB peak. A twin imports only what changed.
- **Production's data** (`restore [--at REF]`, `tools/k8s_staging_data.py`,
  OPS-1-ah-b): production's newest bundle and passphrase, read over ssh
  (`STAGING_PROD_SSH`, `_KEY` in `.env.dev`), sum-checked; deployed at the
  bundle's commit, or `--at` a later one, from a worktree; then B10's restore
  with `--replace`, scrubbed before any service starts (R16). Everything that opens production's secrets — the bundle and
  what it decrypts to, the passphrase, the worktree, the safety bundle — lives in
  `/dev/shm/txnet-staging`, and `/etc/txnet/age.key` is a link into it, never a
  file. A failed `restore` and `down` remove all of it. Images the registry
  lacks are built in the worktree with the build host's env files linked for
  that step only. The kubelet never deletes an image there (GC thresholds
  100/99): with no route out it cannot pull one back.
  Proven 2026-10-29 at `--at 7e49eb78`: 242 tables and Redis matched the bundle,
  1018 users, 39 pods Running, R6's smoke 85 of 85, egress still closed; `down`
  left nothing. It also found OPS-1-ai (the translator fetched its models) and
  that `build` ignored a failed image listing and exited 0.
- **The twin run** (`twin [--from REF] [--to REF]`, `tools/k8s_staging_twin.py`,
  OPS-1-ah-c): `restore` at `--from` (default the bundle's commit), then `--to`
  (HEAD) by `prod.k8s.sh deploy` from its own worktree, old pods beside new as in
  production; then R16's guard again (`contract.scrub.md`: the restore pointed
  the test panels at their local copies on staging's network, TEST-NET-3
  `203.0.113.0/24` so ADR-0095's egress guard lets the drivers dial them, and
  wiped every other panel before any service started).
  Then every check, each even after one fails: K12's `ready`, each pointed
  panel collected from within 600s, K12's `roll` once the 1-minute load is under
  half the cores (up to 600s, said when it is not: at load 9 on 8 cores
  billing's old pod missed its liveness probe and 4 of 2658 requests got 502),
  and `stores`. K12's checks run in the node container (`NODE_EXEC`), never on
  the dev host's own k3s. A worktree left by an earlier run is moved to the
  commit asked; the kubelet evicts at 5% free and `up` refuses unless that plus
  staging's peak (17 GiB) is free. Production's secrets go when the run ends.
  Until 21c9d8f8 reaches production, `--from` is it or later: before it the
  translator (OPS-1-ai) and locale-service's healthcheck need an outside DNS.
  Proven 2026-10-29, `--from 7e49eb78` over the 08:51 bundle: 35 of 35 ready,
  6 of 10 panels pointed and collected from, roll 0 of 2803 failed, stores
  killed and back with their rows; 21 minutes.

**R15 — A release is one command to prove, one to send** (ADR-0166 point 5,
OPS-1-ah-d). `scripts/release.sh [--until STEP] [--from REF]`
(`tools/release.py`), as root on the dev host, runs in order and stops at the
first failure: `clean` (no change `git status` shows, on master; production's
checkout clean and an ancestor of HEAD), `checks` (AGENTS.md's seven), `disk`
(build cache and dangling images freed, R14's room), `build` (R4, R12), `twin`
(R14 from production's running commit, or `--from`). Then it stops (R19).
`release.sh send` runs `push` (R10), `ship` (production's commit..master as a
git bundle over ssh, `merge --ff-only` in its checkout), `deploy` (`prod.k8s.sh
deploy` there, K10, K16), `close` (staging down, the dev stack back). Nothing
leaves the dev host before the twin passed. A release is a batch of fixes.

**R19 — Production waits for the owner** (ADR-0168 point 4, OPS-1-ah-k). A
passed twin leaves staging up and writes `/var/lib/txnet/release.json`: HEAD
and production's commit; a failed one takes staging down. `release.sh approve`
adds the owner's name only in a terminal, with the commit's first 12 characters
typed: an agent's shell has none, and never approves. `send` refuses unless the
record names HEAD, is approved, and production has not moved since; a newer
commit or a new prove needs a new approval, and `close` spends it.

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

R10 live, 2026-10-24: `/v2/` 401 on `registry.mytxnet.ir` from the dev host and the test server;
a 300 MB layer pushed in 22s and pulled back from the dev host, an anonymous manifest read 401.
R10, R11, 2026-10-24: `k8s_deploy_test.py` `test_push_names_an_unreachable_registry_first`;
`k8s_release_test.py` `LoginRolesTest` (a quote and a backslash through stdin) and the
order in `ScriptTest`; the dev path re-run on dev's Postgres, its logins unchanged.

R19, 2026-10-30: `tools/release_test.py` `ApprovalTest`, `OrderTest`, `TwinStepTest`; not yet run live.

R5–R9, 2026-10-24: `tools/k8s_release_test.py` — the probe and route plans,
every one of the production model's IngressRoutes given a request, the record,
and `deploy`/`rollback` driven with a fake `kubectl` (a release not ready or
failing its check rendered back from the earlier commit's worktree, `db-migrate`
not run again, one prune and only after it). Not yet run against a cluster: the
first is the rehearsal (OPS-1-o-f).
