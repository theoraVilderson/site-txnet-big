---
id: adr-0163
status: accepted
updated: 2026-10-24
---

# ADR 0163 — Production is the test server, and the rehearsal runs on it

- **Status:** accepted (rows OPS-1-o-f, OPS-1-o-l…n, OPS-1-p)
- **Date:** 2026-10-24
- **Decision:** the user's (2026-10-24: production on Kubernetes on the test
  server already brought up, the gaps found in the backlog added)
- **Affects units:** hosting (`contract.kubernetes.md` K1, K12, K13, K14)
- **Amends:** ADR-0147 point 6 (the rehearsal on a k3d cluster on the dev host)
  and its context's "there is no production server"; `hosting/open-questions.md`
  2026-10-14.

## Context

ADR-0147 had one server, the dev host, which also runs the user's live site and
bot, so the rehearsal was a k3d cluster (k3s inside Docker) bound to no host
port and deleted after. The test server (8 cores, 11 GB, Ubuntu 24.04) now
runs the compose stack restored from a bundle (OPS-1-af, 2026-10-23), holds no
real user, and the user names it as production.

k3d never meets what production will: k3s on the host itself, beside Docker,
both rewriting iptables; k3s's own listening ports on a public address; a node
pulling from `registry.mytxnet.ir`; 11 GB holding k3s, every service and the
monitoring stack. Rehearsed on the dev host, each of these is first met on the
day of the cutover.

## Decision

1. **Production is the test server.** OPS-1-p is no longer blocked on a
   server; it waits on OPS-1-o only.
2. **The rehearsal (OPS-1-o-f, K12) runs on the test server**, with real k3s
   on the host, the compose stack stopped for it. The dev host keeps
   ADR-0147's rule: no k3s is installed there.
3. **k3s is installed there with the user**, only once its ports are closed
   to the internet (OPS-1-o-l, K13). An agent does not install it alone.
4. **The node pulls from the registry; images are not built on it**
   (OPS-1-o-m, K14). A build on that host starved the running services during
   the 2026-10-23 restore.
5. **The memory fit is measured before the rehearsal** (OPS-1-o-n): the prod
   images' use plus k3s's, against 11 GB, with which workloads run at zero
   replicas if it does not fit.
6. **The cluster that passes the rehearsal is the one cut over to.** OPS-1-p
   restores production's data into it; it is not torn down and rebuilt.

Not decided here: whether production starts empty or from a bundle
(`hosting/open-questions.md` 2026-10-24).

## Consequences

- Positive: every fact the cutover depends on is proven on the machine and
  network it will run on, before any real user is on it.
- Negative / accepted cost: there is no staging server after the cutover. An
  update is proven by its tests and the k3s rollback (K10) only, until a second
  server exists (OPS-1-y needs one anyway).
- Negative / accepted cost: the test server's compose stack is down while the
  rehearsal runs.

## Alternatives rejected

- **Rehearse on k3d on the dev host as planned** — leaves the iptables,
  ports, registry and memory questions to the cutover itself.
- **Wait for a separate production server** — the user has one server for it
  now, and the separate one would be rehearsed on k3d all the same.
