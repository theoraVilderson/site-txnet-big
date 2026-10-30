---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-30
---

# Contract — hosting: a release's reach decides its path

R14's twin proves a release on production's data, and it measured 21 minutes on
2026-10-29: staging up, production's commit deployed and restored, HEAD over it,
then every check. A change to one panel button paid all of it, though it rolls one
pod (R12) and none of the checks reads it. ADR-0169: a release pays for what it
changes in production. The rule is the one Nx already applies to the tests and R12
to the deploy.

## TL;DR
`release.sh`'s `reach` step renders production's commit and HEAD, then compares
them. An image whose tag moved is that service's code; any other difference is the
platform's shape. A compose service declares what proves it (`x-release`). Only a
change whose every moved image declares `lane: quick`, with the shape unchanged,
skips the twin. Anything that cannot be measured takes the full twin.

**R20 — The reach** (OPS-1-ah-l, `tools/release_reach.py`).
- **Measured, not listed.** Each commit is rendered by its own `k8s_render.py`
  (both stacks; a render from before `--stack` renders main alone, and the missing
  monitoring stack reads as a change of shape), with this host's env and secret
  files borrowed into the old commit's worktree (whatever git ignores here, never
  `__pycache__` or the render's own output). Same files on both sides, so the two
  renders differ only by code. Output in `/dev/shm`, removed at once: it holds
  production's secrets. Measured 2026-10-30: 39s per release.
- **Images and shape.** A container is named by its compose service. A tag that
  moved is that service's source (R12); a file that differs once every tag is
  removed, or is added or removed, is the shape: env, probes, routes, resources,
  the render itself.
- **Declared beside the service.** `x-release: { lane: quick }` on a service that
  writes no data (site-pwa, coinsite); `x-release: { checks: [<check>] }` on one
  that a twin check proves: `panels` for network-service (its drivers), `stores`
  for main-db, db-pool, memory-data and rabbitmq, `roll` for gateway-handler and
  authorization-handler (every request crosses them). The render drops the key
  (`tables.py` DROPPED_KEYS), so declaring it changes nothing in production. A
  misspelt lane, check or key stops the release: read as nothing, it would
  quietly take a check away.
- **The lane.** `quick` when the shape is unchanged and every moved image is
  declared quick, or nothing moved. Otherwise `twin`, which runs `ready` plus the
  moved images' declared checks, or all four after a change of shape. A service
  that declares nothing, db-migrate above all (a migration, a seed), always takes
  the twin: it meets production's data.
- **Unknown is full.** `--full`, `--from`, a commit that does not render here (its
  compose against today's env files), or a production that runs a release other
  than its checkout's HEAD (`prod.k8s.sh rollback` leaves the checkout ahead, R9;
  read from `txnet-release`, R8) each take the twin with every check, and say why.
- **What the quick lane keeps.** `checks`, the build, the owner's approval (R19,
  the record names the lane), and production's own smoke check with its automatic
  setting back (R6, R7). Staging is not started and the dev stack stays up, so the
  owner tries the change there. `close` brings staging down only after a twin.
- **Proof.** `tools/release_reach_test.py`, `release_test.py`, `k8s_staging_twin_test.py`;
  on real history (2026-10-30): eb521309 (a migration) twin, `ready`; ec7afa6d
  (billing) twin, `ready`; e6714830 (network) twin, `ready, panels`; a site-pwa-only
  commit quick; HEAD with the declarations against HEAD without them, nothing moved.

## When a feature adds a service
Declare it in the same change. A frontend that writes nothing gets `lane: quick`.
A store, an edge or a new driver family gets the check that proves it. Leaving it
undeclared is safe: the service then always takes the twin.
