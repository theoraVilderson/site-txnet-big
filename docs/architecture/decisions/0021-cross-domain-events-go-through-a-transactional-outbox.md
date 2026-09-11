---
id: adr-0021
status: accepted
updated: 2026-09-09
---

# ADR 0021 — Cross-domain events go through a transactional outbox

- **Status:** accepted
- **Date:** 2026-09-09
- **Affects units:** billing, network, notification, ai, tenant, engagement

## Context

Several flows cross a domain boundary at the exact moment money changes hands:
a confirmed payment must provision a config (`billing` -> `network`), a
commission must be credited (`billing` -> `tenant`), a campaign must be
delivered (`notification`), a usage signal must reach the recommender (`ai`).

ADR-0002 makes the money side one Postgres transaction: append the ledger row,
update the cached balance. The question `D-3` has held open since 2026-09-04 is
how the *other* side learns about it. RabbitMQ is already in
`dev-docker/docker-compose.main.yml` but no backend code connects to it.

The failure that matters is specific: if provisioning is called synchronously
and the panel is slow or down, either the payment transaction rolls back after
the user's money moved, or the money moves and no service appears. Both are
real losses in a prepaid VPN business.

## Decision

We will publish cross-domain events through a **transactional outbox**: the
producing service inserts the event row into an `outbox` table **inside the same
Postgres transaction** that writes the ledger, and a relay process reads
unpublished rows and publishes them to **RabbitMQ**.

Consumers are idempotent, keyed on the event id — the outbox guarantees
at-least-once delivery, never exactly-once, so a consumer that cannot safely
process the same event twice is a bug in the consumer. The relay is the only
thing that talks to RabbitMQ on the producing side; a service never publishes
directly.

## Consequences

- Positive: an event and the state change that caused it commit or fail
  together. There is no window in which money moved and the event vanished.
- Positive: a slow or dead consumer (a panel that is down) delays provisioning
  instead of failing or reversing the payment.
- Positive: the outbox table is an audit trail of what the system decided to
  announce, independent of the broker's retention.
- Negative / accepted cost: a new unit — the outbox table, the relay, and its
  own failure modes (relay stalled, outbox growing, poison message). It needs
  monitoring in `dev-docker/`'s existing stack from the first event, not later.
  **Built 2026-09-10 (F-067-c) inside `automation`, not as a new unit** — the
  status-quo boundary won, which §6.6 makes a note rather than a superseding
  ADR (D-14, on the F-067-c backlog row). One table and one job; splitting it
  out stays cheap while it is still one of each. The monitoring landed with
  it.
- Negative / accepted cost: every consumer carries idempotency bookkeeping.
- Negative / accepted cost: flows become eventually consistent. A user can pay
  and see "provisioning" rather than a config. The UI has to say so honestly.
- Forecloses: a synchronous call across a domain boundary inside a money
  transaction; treating "the event was published" as a fact the producer can
  assert.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Synchronous calls between services | simplest to write and debug, but couples the payment transaction's success to a third-party panel's availability — the exact failure this platform cannot absorb |
| Publish to RabbitMQ directly after commit | less code and the broker is already running, but the window between commit and publish loses events with no record anywhere that one was owed |

## Revisit trigger

The event volume or fan-out outgrows a single relay polling one table, or a
consumer needs ordering guarantees across producers that a per-row outbox does
not give.
