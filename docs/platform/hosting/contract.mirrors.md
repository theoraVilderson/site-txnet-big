---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-11-01
---

# Contract — hosting: where images and packages come from

Every build, pull and host download reaches something abroad: base images, npm,
Go modules, Alpine, Prisma's engines, Debian and PyPI (ibsng), GitHub releases
(k3s, sops, age), MikroTik and SourceForge files. In a national-internet outage
none of them answers. Our own mirrors do: `registry.mytxnet.ir` pulls Docker Hub
and other registries itself (anonymous read, the same `<name>:<tag>` paths as
`docker.arvancloud.ir`), and Nexus at `packages.mytxnet.ir/repository/` proxies
the rest, one repo per source. Each mirror keeps only what was fetched through it
once, so it is warmed while the internet is open (ADR-0170).

## TL;DR
Three variables say where everything comes from, in one committed file,
`mirrors.env`, a copy of one of two profiles. `mirrors.py local` or `upstream`
switches them; this host builds with the new one at once, production takes it at
its next release.

**M1 — One file, read last.** `DOCKER_REGISTRY` (base images), `PKG_MIRROR`
(Nexus's base; empty = each source's own upstream) and `APK_MIRROR` (Alpine's
repository) live in `mirrors.env` at the repo root and nowhere else: not `.env`,
not a sealed file. Nothing in it is secret, so a switch needs no key and no
access to the node. Every reader takes it after its env files, so it wins:
`dev.compose.sh`, `prod.compose.sh`, `prod.k8s.sh`'s `compose()`,
`k8s_render.compose()` (so the render, release, bundle and memfit),
`ship.registry()`, `k8s_staging up`, `tools/pkg_mirror.py`, and the
standalone stacks in `dev-docker/dev-setup.sh`.

**M2 — Two profiles, whole.** `scripts/mirrors/local.env` (inside Iran: our
registry, Nexus, Nexus's alpine repo) and `scripts/mirrors/upstream.env` (the
sources before the mirrors: Arvan's Docker mirror, Arvan's Alpine mirror, every
other source upstream). Each names exactly the three variables; `mirrors.py`
refuses one that does not. `mirrors.env` is always a whole copy of one profile,
named in `MIRRORS_PROFILE`; `test_mirrors.py` fails a hand edit, and `status`
reports one. A new source goes into both profiles in the same change.

**M3 — Each consumer builds its own path.** A Dockerfile takes the variables as
build args and appends the repo it needs: `$PKG_MIRROR/npm/` (registry),
`/go/` (first in `GOPROXY`, then goproxy.io), `/prisma` (`PRISMA_ENGINES_MIRROR`),
`/debian-archive/` (over http: apt checks Debian's signatures), `/pypi/simple`,
`/sourceforge`, `/mikrotik`; Alpine is `$APK_MIRROR` itself. Host downloads go
through `pkg_mirror.mirrored()`, which maps `github.com`, `raw.githubusercontent.com`,
`download.mikrotik.com` and `downloads.sourceforge.net` to their repos and writes
a path's `+` as `%2B`; every caller's sha256 check still applies. An empty
variable keeps the upstream source, so CI and a host with no mirror build as
before.

**M4 — When a switch takes.** On this host at once: the next build and the next
host download read the new file. Production at its next release: the render
names its third-party images from `DOCKER_REGISTRY`, so `deploy` pulls them from
the new place; running pods are not touched. `registries.yaml`'s Docker Hub
mirror (k3s's own images, already in the airgap archive) changes only with
`prod.k8s.sh registries` and a k3s restart.

## Proof
`scripts/mirrors/test_mirrors.py` (the switch, the profiles, the committed file);
`tools/pkg_mirror_test.py`; `scripts/bundle/test_bundle_k8s.py` `ShipRegistry`.
2026-11-01: every image built with `--no-cache` through `local`, and pgbouncer
through both profiles.
