---
id: adr-0077
status: active
updated: 2026-09-21
---

# ADR 0077 — metering runs as its own service

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** billing, network, automation

## Context

`network-service` publishes one message per collection pass over one panel
(F-027-m). Something has to turn that message into usage: a `traffic_raw_log`
row per delta, the Grant's `consumedBytes`, the quarantine and hold queues, and
the deduplication that makes at-least-once delivery an exactly-once effect
(F-027-n).

Three homes were available and none of them was obviously right.

`billing-service` was what the backlog row named. It already holds the two
pools this work needs — the application pool with `withTenant` and
`tenantTransaction`, and `CrossTenantPrismaService` — so the tenant binding
that `traffic_raw_log`'s RLS policy requires (F-027-ak) is a call rather than a
build. Against it: that service is a request edge, its `PrismaService` says in
so many words that it queries only the `billing` schema, and it has never held
a broker connection.

`worker-service` owns every consumer on this platform today. Against it: it has
neither the tenant extension nor a cross-tenant pool, and the read that
resolves a delta's config to its tenant cannot be scoped — a pass over a
platform-owned panel carries no `tenantId` at all. Both would have to be built
there, and the pipeline's volume would then sit behind the tick, OTP and
bot-update queues.

The volumes are not comparable to anything else on this broker. One pass is up
to 500 deltas, a pass happens per panel per interval, and `traffic_raw_log` is
the highest-volume table on the platform — partitioned by month precisely
because of that (F-027-e).

## Decision

Metering is its own Nx application, `txnet-backend/metering-service/`. It
consumes `network.usage.#`, writes usage, and does nothing else. It serves no
HTTP: like `worker-service` it boots through `createApplicationContext`, and
unlike it, it holds the cross-tenant pool — a process holding that should have
no door on it.

It carries the two pools for the reason above: the application pool for every
write, with the config's tenant bound per delta by `tenantTransaction`, and the
cross-tenant pool for exactly one read, the one that produces the tenant.

## Consequences

- Positive: the pipeline scales on its own. The one process on this platform
  whose load follows the number of panels rather than the number of people
  using it can be given replicas without giving them to a request edge.
- Positive: `billing-service` keeps the boundary its own code documents — one
  schema, one request edge, no broker.
- Positive: a backlog of usage cannot sit in front of an OTP, and the two
  depths are alerted on separately (F-067-g).
- Negative / accepted cost: a fourth backend app to deploy, configure and watch,
  for one consumer. The scaffold is copied from `worker-service` and the
  substrate is the same; what is genuinely new is one queue and one module.
- Negative / accepted cost: a second holder of the cross-tenant pool. The audit
  stays the one `grep -rn CrossTenantPrismaService` gives, and in this service
  the list is one method.
- What this forecloses: metering reaching into billing's code. An Nx app cannot
  import an Nx app, so anything the two must agree on becomes `shared-core` or
  an internal seam — which is the constraint that keeps `consumedBytes` a
  measured cursor and not a charge.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A `metering/` folder in `billing-service` (what the backlog row said) | it puts the platform's highest-volume writer inside a request edge, and gives a process that answers users the cross-tenant pool |
| A consumer in `worker-service` | the tenant extension and the cross-tenant pool would both have to be built there, and usage would queue behind ticks and OTPs |
| Fold it into `network-service` (Go) | Prisma owns this schema (ADR-0071) and the Grant cursor is entitlement's; the collector would then write tables it does not own, in the language that does not own them |

## Revisit trigger

Metering staying small enough that its own deployment is not worth the
operational surface — or the opposite, a second consumer of the same pipeline
(the RADIUS receiver's output, F-027-af) making this process a place work is
added to rather than a single consumer.
