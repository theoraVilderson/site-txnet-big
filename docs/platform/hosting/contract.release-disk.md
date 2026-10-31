---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-31
---

# Contract — hosting: what a release leaves behind

R15's `disk` step ran `docker builder prune` and `docker image prune`. Neither
reached what a release leaves: every earlier release's images stay tagged
(`registry.mytxnet.ir/txnet/<service>:<tag>`), so a dangling-only prune never
sees them, and `docker builder` is the engine's own builder while compose builds
with buildx's current one. On 2026-10-31 the dev host held 12 GB of earlier
releases' images and an 11 GB build cache, 81% of its disk.

The registry (`registry.mytxnet.ir`, `registry:2` on Arvan CaaS, push login only,
`deleteEnabled: true`, a 50 G volume) held every tag ever pushed: 5.4 GB on
2026-10-31, ~340 MB a release.

## TL;DR
Before `build`, a local tag of a repository the release builds, that the release
does not name, is removed. The build cache is capped. Volumes are never pruned.
After a deploy, the registry keeps the last 5 releases' tags; `rollback` reaches
only those.

**R21 — The disk step** (`tools/release_disk.py`, called by `release.py`).
- **Which tags.** The release's images are `k8s_render.py --images`, the list
  `build` and `push` use. Each tag is its service's source fingerprint (K8), so an
  unchanged service keeps its tag and its image stays. Any other tag of those
  repositories is an earlier release's: `docker rmi`, never forced, so a tag a
  container still runs is refused and stays. Any other repository (`devtxnet-*`,
  `txnet/postgres`, base images) is never touched.
- **Rollback is unaffected.** R9 renders the earlier commit and the node pulls its
  tags from the registry (K14); no local image is read.
- **The cache.** `docker buildx prune --keep-storage 3gb` on the current builder,
  the one compose builds with, then the engine builder and dangling images.
- **Then R14's room**, unchanged: the step fails when the twin would not fit.

Test: `tools/release_disk_test.py`.

**R22 — The registry keeps the last 5 releases** (`tools/release_registry.py`,
OPS-1-ah-m; `IMAGES_KEPT` in `k8s_release.py`).
- **After `deploy`**, `close` reads production's R8 history, renders each of the
  last 5 commits as R20 renders production's, and deletes every other tag of the
  repositories they use. A repository no kept release uses (`push-proof`) stays.
- **By digest, never a kept one.** A DELETE removes every tag on a digest, so a
  digest a kept tag resolves to is never deleted.
- **Unknown is not stale.** A kept commit that does not render, or an API error
  while planning, deletes nothing; one mid-way stops there. Either way `close`
  reports it and the release stands.
- **`rollback [tag]`** refuses a tag outside the last 5 before rendering, naming R22.
- **Space returns only on garbage-collect.** A delete frees no blob. By hand, in
  Arvan's console for the registry app, with no push running:
  `registry garbage-collect --delete-untagged /etc/distribution/config.yml`.
- By hand: `python3 tools/release_registry.py [--dry-run] <history...>`. Measured
  2026-10-31 on production's history: 266 tags, the 5 releases' 26 images all
  present, ~2.2 GB of 5.4 GB left after collection.

Test: `tools/release_registry_test.py`.

## Consumes

R8, R9, R14, R15 in `contract.release.md`; R20 in `contract.release-reach.md`; K8, K14 in
`contract.kubernetes.md`.
