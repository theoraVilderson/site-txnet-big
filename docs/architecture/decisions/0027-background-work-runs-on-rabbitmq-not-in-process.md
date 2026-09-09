---
id: adr-0027
status: accepted
updated: 2026-09-09
---

# ADR 0027 — Background work runs on RabbitMQ, not inside a request process

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** automation, tenant, currency, engagement, fraud, network, notification

## Context

`automation` has described scheduled and background work since 2026-09-04
without naming a runner, and the gap is no longer theoretical — three shipped
or specified pieces are waiting on it:

- `CredentialVaultService.destroyExpiredVersions` (F-066-f) has no caller,
  because there is nothing to call it on a schedule.
- ADR-0021 decided a transactional outbox and named RabbitMQ as its transport,
  but nothing runs the relay that drains the outbox.
- Exchange-rate refresh (`currency`), the nightly spin-wheel reset
  (`engagement`), fraud scans and traffic polling (`network`) are all specified
  as periodic work.

`@nestjs/schedule` is already a dependency, and RabbitMQ is already declared in
`dev-docker/docker-compose.main.yml` with no backend code connecting to it. The
question `D-6` has been: which of the two is the runner.

The failure that decides it is scale-shaped rather than convenience-shaped. An
in-process scheduler runs inside a replica, so two replicas run every job
twice; the answer to that is a distributed lock per job, which is a queue with
the durability removed. It also gives a slow job no place to be slow: the job
shares a process with request handling, so a long traffic poll degrades logins.

## Decision

Background work runs as **RabbitMQ consumers in a worker process**, separate
from any process that serves requests.

- A schedule is a message: a small timer publishes `automation.tick.<key>`
  messages, and workers consume them. What runs the timer is an implementation
  detail of the worker deployment, not of a business unit.
- The outbox relay ADR-0021 requires is the first such worker, not a second
  mechanism.
- A worker is idempotent and safe to run twice, for the same reason ADR-0021's
  consumers are: delivery is at-least-once.
- `automation.BotWorker` rows stay what they already are — the *definition* and
  the run log of a job. This ADR decides only where the code runs.

`@nestjs/schedule` stays a dependency and may still drive the timer inside the
worker process. What it must not do is run business work inside `auth-service`
or any other request-serving process.

## Consequences

- One new deployable (a worker app in the Nx workspace) and one real RabbitMQ
  dependency in production, not just in the compose file. Nothing in the
  request path gains a dependency on the broker.
- A job that must not run twice needs its own guard; the queue does not provide
  one. This is the accepted cost of at-least-once, and it is the same cost
  ADR-0021 already accepted.
- Until the worker app exists, everything above stays unbuilt — including
  `destroyExpiredVersions`, which means a rotated DEK version is retained
  rather than destroyed. That is a retention gap, not a disclosure one
  (`domains/tenant/contract.vault.md`).
- Reversing this means moving jobs back in-process, which is cheap for a job
  with no queue semantics and expensive for one that has grown them. That is
  why it is an ADR rather than a note.
