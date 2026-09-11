---
id: automation
layer: domain
status: active
version: 6
updated: 2026-09-10
---

# Contract — automation: what is watched

A §10 split of [contract.worker.md](contract.worker.md), which reached the
250-line ceiling. That file is the worker runtime — the tick, the jobs, the
dead-letter path. This one is the layer above it: the alerts that tell a person
any of it has stopped working.

The halves are split where the audiences are. Nothing that calls the runtime
reads an alert threshold, and nobody woken by one of these needs the tick
topology to act on it.

The section above ends with a table nobody was reading. Five Prometheus alert
rules now watch this queue — the first alert rules the platform has had, and the
first thing ever able to fire into the Bale receiver Alertmanager has carried
since 2026-09-04. How they are wired is `docs/operations/observability.md`; what
they mean is here.

| alert | it means |
|---|---|
| `AutomationBrokerDown` | nothing below can be trusted — the broker stopped answering |
| `AutomationQueueBacklog` | ticks arrive faster than `AUTOMATION_PREFETCH` drains them |
| `AutomationQueueNoConsumer` | no scheduled job is running at all |
| `AutomationDeadLetterArrived` | invariant #9's other branch — a message did not run |
| `AutomationDeadLetterDrainStalled` | the queue holds the only copy of a failure, and no row is being written |

Three things about them are worth knowing before changing either side.

**The queue names in the rules are literals.** They are the `AUTOMATION_QUEUE`
and `AUTOMATION_DEAD_QUEUE` defaults, so an environment that overrides either
must move the rule with it. A rule that silently matches nothing is worse than
one that fails to load, which is why they are not templated.

**There is no consumer-lag metric, because RabbitMQ has no consumer offset.**
The pair that answers the same question is queue depth and consumer count, and
the alerts read exactly those. `AutomationQueueNoConsumer` also fires when the
series is *absent*: `worker-service` is what declares this queue, so a process
that has never booted leaves no series for a `== 0` to match, and that is the
failure the alert most needs to catch.

**The dead-letter alert counts rejections, not queue depth.** `DeadLetterDrain`
empties that queue continuously and by design, so its depth is back to zero
between two scrapes and an arrival is never seen. The counter RabbitMQ keeps for
`basic.reject` / `basic.nack` dead-letterings is exactly the mechanism this unit
uses, so it catches every one. Its limit is that it is broker-wide: automation's
is the only dead-letter exchange on this broker today, and the day a second one
exists this alert stops being able to say which produced the message.

## The outbox (F-067-c)

F-067-g's fourth number arrived with the table it reads. Three more rules, in
their own group, and the first thing on this platform that is watched from
**Postgres** rather than from the broker — an unpublished outbox row has by
definition never reached RabbitMQ, so nothing on the broker side can see it.

| alert | it means |
|---|---|
| `AutomationOutboxStalled` | a committed transaction promised to announce an event and it has not gone out |
| `AutomationOutboxBacklog` | the relay is publishing, but slower than events arrive |
| `AutomationOutboxRowRefused` | one row the broker keeps refusing — read its `lastError` |

**The scrape target is new, and it is an exporter rather than a `/metrics`.**
ADR-0027 makes `worker-service` a deployable that serves no requests; bolting
an HTTP surface onto it to expose one gauge gives back exactly what that ADR
removed. `postgres-exporter` runs the single query in
`dev-docker/monitoring/config-dev/postgres-queries.yaml`, with its default
collectors switched off, and connects as `txnet_app_user` — the RLS-enforced
role, not the owner.

**The floor on every threshold here is `AUTOMATION_TICK_INTERVAL_MS`,** because
the relay is a scheduled job like any other. A row thirty seconds old is not
late; a row five minutes old has missed several ticks.

**`AutomationOutboxRowRefused` is expected to fire on the first producer's
first event**, and that is the point rather than a flaw: no domain binds a
queue to `outbox.#` yet, every publish is `mandatory`, and the relay never
gives up on a row (`contract.outbox.md`). A climbing attempt count is the only
thing separating "retrying" from "will retry for ever".
