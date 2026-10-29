---
id: adr-0166
status: accepted
updated: 2026-10-29
---

# ADR 0166 — A release passes a production twin on the dev host before it reaches production

- **Status:** accepted (rows OPS-1-ah, OPS-1-ah-a … OPS-1-ah-d)
- **Date:** 2026-10-29
- **Decision:** the user's (2026-10-29: "the best and most principled option, so
  that what I take to production really does not cause trouble"; staging data:
  a copy of production's, chosen over a seed)
- **Affects units:** hosting (release, nodes, backup)
- **Extends:** ADR-0147, ADR-0164 (K10, K12, K16). Amends K17's dev-host bullet
  (2026-10-29: the dev host carries no release pod).

## Context

Development moved back to the dev host's compose stack (live reload, no image
per change). Production is k3s on the test server (barghgho.ir), and nothing
sits between the two. Compose and k3s share each service's definition (K2), but
not these, and each has already broken a release:

- **The image, not the source.** Dev runs bind-mounted source under a watcher;
  production runs the built image. A file not copied, a dependency only in
  `devDependencies`, a build step: seen only in the image.
- **Kubernetes' own behaviour.** Readiness, rolling update (old and new pods
  side by side ~3 min), migrations before rollout, memory requests, disk
  pressure. LIVE-1-z (2026-10-28): a migration zeroed 14 rows and the old pods
  refilled them; R7 (2026-10-26): DiskPressure evicted pods mid-rollout.
- **Real data.** Dev's database never held the rows LIVE-1-z rewrote.

K10's deploy already sets a failed rollout back (K16), but a release that is
*ready* and wrong — LIVE-1-z — passes every probe.

## Decision

1. **A staging cluster on the dev host**: k3s at `K3S_VERSION` inside one
   privileged Docker container (the recipe proven 2026-10-24 for OPS-1-o-d),
   created per release and removed after it. Not a namespace of the production
   cluster: that would share its API, its nodes and K17's tunnel.
2. **No route out.** The container sits on a Docker `--internal` network: it
   reaches the dev host's local panels (`/root/paneltest`) and nothing else. A
   pod's request to the internet is checked to fail **before** any data is
   restored; if it succeeds, staging stops there. This is the guard that lets
   it hold production's data and secrets: it cannot reach a real panel, a
   payment gateway, a bot, SMS or mail.
3. **Production's data**: the newest nightly bundle (OPS-1-ad), restored with
   `backup.py restore --stack k8s` into staging. Production's secrets open in
   `/dev/shm` only, as K5 does on the node; the data's encrypted columns need
   them.
4. **The same release path, twice.** `prod.k8s.sh deploy` with `KUBECTL`
   aimed at staging: first production's running tag (R8's record), then the
   new tag — so the migration and the rolling update run exactly as they
   will in production, old pods writing beside new ones.
5. **The gate.** After the second deploy: R6's smoke, K12's rolling update
   under a request loop with zero failures, the stores restarted with their
   data, and the drivers against the local panels. Only a pass pushes and
   deploys to production (`scripts/release.sh`, OPS-1-ah-d); production's
   deploy is then the one already rehearsed, on the images already proven.
6. **Memory is time-shared.** Production's requests are ~9.2 GB (K19) and
   the dev host has 15 GB: the dev stack is stopped for the run (~15–20
   minutes) and started again however the run ends.
7. **Images never cross the internet to reach staging**: built on the dev
   host (R4) and imported into the container (`ctr images import`). Only a
   passed release is pushed.

## Consequences

- A release costs ~15–20 minutes more and the dev stack is paused for it.
- Production data lives on the dev host while a run lasts; the container and
  its volumes are removed at the end, pass or fail.
- What the twin cannot show: two nodes (staging is one), real panels' and
  gateways' answers (only the local panels), and load beyond K12's loop.
- Cheaper option rejected: build the images and start them under compose
  before pushing. It catches the image class only — not LIVE-1-z, not R7.
