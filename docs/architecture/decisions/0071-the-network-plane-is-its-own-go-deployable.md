---
id: adr-0071
status: active
updated: 2026-09-21
---

# ADR 0071 — the network plane is its own Go deployable

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** network, entitlement, billing, redis-keyspace

## Context

The `network` unit is schema only: six tables from `20260908000000_init`,
`source: []`, and no TypeScript anywhere reads or writes them. What has to be
built on top of them is unlike anything else in this repo.

It talks to **six unrelated families** of third-party management systems — the
Xray panels (Marzban, Marzneshin, Sanaee, x-ui, Hiddify), two ISP billing
systems (IBSng, Cloudius), and two Mikrotik surfaces — over two different
transports. One is HTTP polling we initiate. The other is a **RADIUS accounting
receiver**: a UDP listener holding a shared secret per NAS, normalising
`Accounting-Start / Interim-Update / Stop` packets as they arrive.

It also runs a loop that must stay honest under load: every healthy panel read
on a 60-second pass with bounded concurrency, plus a hot list re-read on a
self-tuning interval down to two seconds, plus a convergence loop writing
desired state back. None of that is request-shaped, and none of it belongs in a
Nest HTTP app.

Two constraints decide where it cannot go. `C-02` and ADR-0002 put every
balance change in one Postgres transaction that appends the ledger row and
updates `cachedBalance` together, and that code is
`shared-core/src/lib/billing/wallet-ledger.ts`. And the collector is inherently
cross-tenant, so it connects as a role that bypasses `tenant_isolation`.

## Decision

We will build the network plane as **`network-service/`, a new Go module and a
new `go.work` member**, owning the driver contract, the RADIUS receiver, the
collection loops, the ceiling allocator, the convergence loop, and `pgx` access
to `network.*` and nothing else. (ADR-0094 lets it read five columns of
`entitlement.grant`, and write none.)

**Go never touches a wallet.** It publishes usage deltas to RabbitMQ; the
`billing-service` metering module consumes them, moves money, and writes the
allocations back. Go reads an allocation and applies it to a panel — it never
decides one. A ceiling written without a purchase behind it would break the
guarantee ADR-0072 rests on, and this boundary is what makes that impossible
rather than merely discouraged.

Prisma stays the owner of the schema. Go reads and writes rows and **generates
no migrations**; on boot it verifies the columns it depends on exist and
refuses to start if they do not.

## Consequences

- Positive: the RADIUS receiver, the polling loops and the convergence loop
  live in the runtime built for them. A UDP listener and a 2-second loop inside
  a Nest HTTP app would be the wrong shape in a language with the wrong
  concurrency model for it.
- Positive: the money boundary is a process boundary, not a code review. The
  one service that could write a ceiling has no credentials for a wallet.
- Negative / accepted cost: **four new Go dependency families.** The Go tree
  today has almost nothing — `auth-handler/go.mod` carries gRPC, and its Redis
  client is hand-rolled and understands only `GET` and `AUTH`. Postgres and
  RabbitMQ appear nowhere in it. This brings `pgx`, an AMQP client, a fuller
  Redis client and a RADIUS library, each with its own supply chain.
- Negative / accepted cost: **a new attack surface.** The RADIUS receiver takes
  UDP from the internet under a shared secret. It must sit behind an IP
  allowlist with a distinct secret per NAS, and that is operational work that
  does not exist today.
- Negative / accepted cost: **the test and convention tooling does not see
  Go.** `npm run test:affected` and `typecheck:affected` read the Nx graph;
  `conventions.py`'s `C-03` check globs `auth-handler/**/*.go` only. Both need
  widening, and the Redis key builder must be repeated in the new root.
- Negative / accepted cost: **RLS is bypassed by design.** The collector spans
  every tenant, so it connects as `txnet_cross_tenant`. The security
  consequence is a hard rule: **this service never answers a user request
  directly.** Nothing about it is reachable from the gateway.
- What this forecloses: sharing Prisma models, `shared-core` validation, the
  i18n key constants or `RateLimitBucket` with this plane. Anything crossing
  the boundary is declared once and read from both sides (`C-04`'s pattern,
  extended to routing keys and the delta message shape per `C-08`).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A module inside `billing-service` | it would put a UDP listener and a 2-second polling loop inside an HTTP app, and give the process that writes ceilings direct access to `WalletLedgerService` — the one separation ADR-0072's guarantee depends on |
| A new NestJS service | the boundary would be right but the runtime wrong. Six driver families, a RADIUS receiver and thousands of concurrent panel reads is the workload Go is chosen for elsewhere in this repo (`auth-handler`, `locale-service`) |
| Extend `worker-service` | it is a job runner on RabbitMQ (ADR-0027). A long-lived UDP listener and a stateful hot loop are not jobs, and the cross-tenant role would leak into a service that does run tenant-scoped work |
| Put it in `auth-handler` | that gateway is on the request path for every call in the platform. Adding panel polling to it couples sign-in latency to a third party's API |
| Let Go write the wallet directly | `C-02` and ADR-0002 require the ledger row and `cachedBalance` in one transaction through one code path, and that path is TypeScript. A second implementation in Go is two truths about money |

## Revisit trigger

Either of:

- The driver set collapses to one family with one transport. The case for a
  separate runtime is mostly the six-families-two-transports shape; without it,
  a Nest module is worth re-costing.
- The Go dependency burden proves worse than the coupling it avoids — most
  concretely, if the RADIUS receiver has to be operated separately anyway, at
  which point the rest of the service has less reason to be where it is.
