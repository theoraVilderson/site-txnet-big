---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-31
---

# Contract — hosting: the build host's disk before a release builds

R15's `disk` step ran `docker builder prune` and `docker image prune`. Neither
reached what a release leaves: every earlier release's images stay tagged
(`registry.mytxnet.ir/txnet/<service>:<tag>`), so a dangling-only prune never
sees them, and `docker builder` is the engine's own builder while compose builds
with buildx's current one. On 2026-10-31 the dev host held 12 GB of earlier
releases' images and an 11 GB build cache, 81% of its disk.

## TL;DR
Before `build`, a local tag of a repository the release builds, that the release
does not name, is removed. The build cache is capped. Volumes are never pruned.

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

## Consumes

R14, R15 in `contract.release.md`; K8, K14 in `contract.kubernetes.md`.
