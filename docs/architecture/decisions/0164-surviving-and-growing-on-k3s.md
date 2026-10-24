---
id: adr-0164
status: accepted
updated: 2026-10-24
---

# ADR 0164 — Surviving and growing on k3s: backups off the node, releases that roll back as one, flags instead of blue/green

- **Status:** accepted (rows OPS-1-o-o…r, OPS-1-ag; K9, K15–K18)
- **Date:** 2026-10-24
- **Decision:** the user's (2026-10-24: "whatever backup, discovery, move,
  new node, rollback, blue/green, load balancer and secrets lack, add it")
- **Affects units:** hosting (`contract.kubernetes.md`), tenant (OPS-1-ag)
- **Amends:** nothing; extends ADR-0147 and ADR-0163.

## Context

Checked against ADR-0147 and K1–K14, eight concerns. Four were already
covered: service discovery (K4: a Service per compose name, CoreDNS resolves
what compose's DNS did, and an unexposed call fails the render), a per-workload
rollback (K10), environment as hashed Secrets (K5, K7) and Traefik behind
`servicelb` (K9). Four were not:

- The pgBackRest repository is a host path on the node. The only copy off it
  is the nightly bundle, so a lost disk loses up to a day.
- K10 undoes the one workload that failed; the others of the same release stay
  new, so a release that fails half-way runs mixed versions.
- Adding a node and moving to another server were one line in ADR-0147
  ("`k3s agent` joins") with nothing behind it; `local-path` volumes cannot
  follow a pod to another node.
- Nothing lets a feature reach production without reaching every tenant.

## Decision

1. **Backups leave the node continuously** (K15): pgBackRest `repo2` on S3 with
   object lock. Its key must list and expire, so B7's write-only rule moves to
   the bucket's lock. Locked for 30 days (user, 2026-10-24); the bucket is named at OPS-1-p.
2. **A release rolls back as one** (K16): tags are commits, a smoke check
   follows every deploy, and a failure sets every workload of the release back.
   Migrations are not rolled back; C-39 already makes that safe.
3. **No blue/green stack.** Two full stacks need twice the 11 GB, and both
   would share one Postgres, Redis and RabbitMQ, so a migration or a queue
   consumer is not isolated by it anyway. Rolling updates gated by readiness
   (ADR-0147 point 5) give the zero downtime; K16 gives the way back.
4. **A risky feature is switched per tenant instead** (OPS-1-ag): shipped off,
   on for the platform's own tenant, then for resellers, off without a deploy.
   Owned by `tenant` (user, 2026-10-24).
5. **A node joins over WireGuard** (K17), data stores pinned by label; **a move
   is a join, a standby promotion and a drain** (K18). Both wait for a second
   server; until then a move is a bundle restore (~10 min).
6. **Traefik sees the visitor's address** (K9: `externalTrafficPolicy: Local`),
   and **Secrets are encrypted at rest** (`--secrets-encryption`, OPS-1-o-j).
7. **Secrets are SOPS files encrypted to an age key, in the repo** (user,
   2026-10-24; K5): versioned, no extra service on 11 GB, unchanged on a second
   node or a move. Rejected: Vault or Infisical (a service to run and back up),
   Sealed Secrets (a controller, and the key is the cluster's).

## Consequences

- Positive: a lost disk costs minutes of data; a bad release is undone whole.
- Positive: the second server is a join, not a migration.
- Negative / accepted cost: an S3 bucket with object lock is a running cost,
  and a locked backup cannot be deleted early, even on purpose.
- Negative / accepted cost: without blue/green, a release cannot be tried on
  production traffic before it serves it; flags and the smoke check cover that.

## Alternatives rejected

- **Blue/green of the whole stack** — point 3.
- **Canary by Traefik weights** — every workload runs one replica on 11 GB;
  a second Deployment per canary is the same memory cost, for one service.
- **A write-only key for pgBackRest** — pgBackRest cannot expire or verify
  without listing; the lock gives the same protection.
