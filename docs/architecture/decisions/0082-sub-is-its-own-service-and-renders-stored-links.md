---
id: adr-0082
status: active
updated: 2026-09-24
---

# ADR 0082 — `/sub` is its own service, and renders links stored at convergence

- **Status:** accepted
- **Date:** 2026-09-24
- **Affects units:** sub-api, network, entitlement, tenant

## Context

Catalog §7.5 calls `GET /sub/{token}` the hottest path in the system. It must
answer under 50 ms at p99, write nothing to Postgres, and serve a Grant's
configs on currently healthy panels. It is also the surface most likely to be
filtered, and catalog C-16 says it must never take the panel down with it.

A Grant already has several configs, on panels of different families
(F-027-*), and every driver can build a client's link (`BuildLink`,
`SubscriptionURL`, `panel.clientBaseUrl`, F-027-bg). Nothing serves those links
yet. `network-service` holds the collector and ceiling enforcement (ADR-0071),
and `billing-service` holds the traffic edge.

Catalog C-17 reads as "proxy the panel's native subscription URL at request
time". That serves exactly one panel per request, and every `/sub` hit becomes
a request to a server we do not own and whose budget is metered
(`contract.budget.md`).

## Decision

1. **`/sub` is served by its own Go deployable, `sub-service`** (unit
   `sub-api`), not by `network-service` or `billing-service`. It is read-only.
   A flood of `/sub` traffic, or a crash in it, cannot stall the collection
   loop that enforces ceilings, and a collector restart cannot empty
   subscriptions.
2. **A config's link lines are captured at convergence and stored.** When the
   provisioning pass creates, regenerates or moves a client, the driver returns
   every link line the panel gives that client. The lines are stored on the
   `config` row. `/sub` renders from that store, with a Redis-cached render in
   front (catalog C-07's key). **It never contacts a panel.**
3. **One link per Grant merges all of its configs,** whatever the panel family,
   on healthy panels only. Panel groups (§7.3, one service created on several
   panels at once) come later. They add configs to the same store and change
   nothing in `/sub`.
4. **C-17 is kept only for what it protects.** The token is ours, and no
   panel's own URL or host is shown to the user. Proxying at request time is
   not built. A `LegacyUpstream` migration is its own later decision.

## Consequences

- Positive: `/sub` stays up with every panel down, and it serves the last
  captured lines of the healthy ones. A panel's request budget is spent only
  by convergence, never by a subscriber's client app.
- Positive: configs from several families merge into one body. Adding a family
  means adding one driver method.
- Negative / accepted cost: a link changed on the panel by hand is stale until
  the next capture. Drift repair (`contract.drift.md`) re-keys the client, and
  capture has to run again on every re-key, not only on create.
- Negative / accepted cost: one more deployable. It needs its own boot column
  assertion and route, and it needs `TenantStatusPolicy`'s `subscriptionLink`
  column in Go. Today that column is enforced only in TypeScript.
- A family whose driver cannot capture links contributes nothing to `/sub`.
  That is visible, not silent: such a config has no stored lines.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Serve `/sub` inside `network-service` | the hottest, most-filtered path would share a process with ceiling enforcement, and one would take the other down |
| Serve it inside `billing-service` | the same coupling, with the panel's traffic edge and payments |
| Proxy the panel's native subscription per request (literal C-17) | cannot merge panels. Every hit costs a panel request, and a dead panel becomes a slow `/sub` instead of a missing line |
| Build lines from the driver at request time | a driver call on the hot path, with no way to meet 50 ms at p99 against a slow panel |

## Revisit trigger

A family whose links change on the panel without any config change we make
(rotating keys, per-request tokens). Stored lines would go stale for it, and
it would need a capture schedule, not only capture at convergence.
