---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-22
---

# Metering — a collection pass becomes usage

What governs `metering-service` (ADR-0077, F-027-n): the process that consumes
`network.usage.#` and writes what a pass measured. Read it before changing what
a delta does, or before adding a second consumer of the same pipeline.

**Usage is visible here and nobody pays.** `grant.consumedBytes` is the
measured cursor; `billedBytes` is the money one and belongs to the block
purchaser (F-027-q, [contract.traffic-block.md](contract.traffic-block.md)).
Nothing in this process reads a wallet, a price or a rate.

## The wire

One message is one pass over one panel, published by `network-service` under
`network.usage.delta` and declared field by field in
`contracts/network/delta.json` — which is the contract, because the publisher
is Go and cannot import `shared-core` (ADR-0036). This side is held to it by
`shared-core/src/lib/automation/usage-delta.contract.spec.ts`; the schemas in
`usage-delta.ts` are what the consumer parses with.

A message whose `version` is not the one this consumer was written against is
**refused, not interpreted**: it dead-letters, because a body with different
fields read as these ones is a wrong number rather than an error.

## Where each figure lands

Every measured byte is billed, held, quarantined or written down — never
dropped (network invariant 18). Four destinations, and the choice between them
is made per row:

| what arrived | where it lands |
|---|---|
| a delta whose `config` claims that remote client | `traffic_raw_log` + `grant.consumedBytes` |
| a delta whose `config` claims a **different** remote client | `usage_hold`, reason `attribution_ambiguous` |
| a delta naming a config this platform does not hold | `unattributed_usage`, against the panel's own identifier |
| the pass's `quarantines` | `usage_delta_quarantine`, as the collector judged them |
| the pass's `unattributed` | `unattributed_usage` |

The hold is why the message carries `remoteId` beside `configId`: a wrong
attribution is visible in the message that made it, and bytes we believe but
cannot place are held rather than charged to whoever is nearest (ADR-0074).
Holds surface in the systems page's holds queue (F-027-ad), which is what makes
"in doubt, do not charge" checkable rather than claimed.

## Applied at most once

Delivery is at-least-once and `deltaId` is derived from the delta itself, so a
redelivery carries the id its first delivery carried. Each delta is applied in
**one transaction that inserts `usage_delta_seen` beside the write it
authorises**: the insert is the deduplication (network invariant 19), and a
unique violation is absorbed as "already applied" — never retried, never
counted twice. The bulk read of already-seen ids before the loop saves
transactions and is not the guard; `metering.service.spec.ts` defeats it on
purpose and asserts the figure is still applied once.

A hold costs the same seen row as a billed delta, so a redelivered pass does
not hold the same bytes twice.

`unattributed_usage` has no delta id to dedupe on, so it dedupes on time: the
update applies only to a row whose `lastSeenAt` is **before** this observation.
A redelivered pass carries the same `observedAt` and therefore adds nothing.

## Tenant scope — the label, not the permission

`traffic_raw_log` (F-027-ak) and `grant` carry RLS policies keyed on
`app.tenant_id`, and neither model is in `TENANT_SCOPED_MODELS`, so nothing
binds that setting on their behalf: `tenantTransaction` does it as the
transaction's first statement, under the tenant the delta's config named.

That tenant comes from a read on `CrossTenantPrismaService`, and it is this
service's only cross-tenant read. It cannot be scoped: a pass over a
platform-owned panel carries no `tenantId` at all (network invariant 9), so the
read that produces the scope cannot run inside one.

A suspended reseller's traffic is still recorded. `TenantStatusGuard` is not
registered here and C-11 excepts this service for that reason: a panel reports
a figure once, so refusing to record it loses bytes permanently — invariant 18's
failure, arriving as a policy decision. Recording is not charging.

## Failure

A handler that throws does not ack, so the pass dead-letters (F-067-d) with its
bytes still owed rather than recorded as applied. Nothing is lost by that: the
collector's cursor moves only after a successful publish, so the same counter is
read again on the next pass, and whatever *was* applied before the throw is held
by `usage_delta_seen` against the redelivery.
