---
id: billing
layer: domain
status: active
version: 1
updated: 2026-09-27
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

## A released hold

The holds queue's release (F-027-at, ADR-0080 decision 3) arrives on the same
queue, bound to `outbox.network.usage.release`: `billing-service` queues it
through its outbox ([contract.systems.md](contract.systems.md) rule 10). The
body is an `OutboxMessage` parsed with `usageReleaseMessageSchema`; its payload
names the hold, who released it and why — **never bytes**.

`MeteringService.release` reads the hold across tenants (it produces the
tenant, as `configsOf` does) and, in **one transaction** under the config's
tenant, flips it `pending -> released` conditionally, then writes what a billed
delta writes — the seen row under `usageReleaseDeltaId(holdId)`, the raw log at
`heldFrom`, the Grant cursor — through the same `charge` a collected delta
takes. A hold no longer pending (released by an earlier copy, or written off
after the release was queued) is `already_resolved`: acked, nothing billed. A
hold that does not exist throws and dead-letters, as evidence.

`metering.service.spec.ts` pins it: billed once, never after a write-off, and
still once with the state pre-read defeated.

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

## Live usage for `/sub` (F-609-a)

After a charge commits — a collected delta or a released hold — the Grant's
`consumedBytes` as that transaction left it is written to `sub:usage:<grantId>`
(redis-keyspace catalogue) by `SubUsagePublisher`, for `sub-service`'s
`Subscription-Userinfo`. Three rules:

1. **Redis never costs a delta.** The write is outside the transaction and
   `publish` never throws: a failure is logged, the pass is acked, and nothing
   is retried — the Grant's next delta carries a newer total. The connection
   has no offline queue and is not awaited at boot, so a Redis outage neither
   holds a pass nor stops the process.
2. **Never lowered.** One Lua script writes the total only when it is larger
   than what the key holds. `consumedBytes` only grows, and two replicas can
   reach Redis in the opposite order from their commits.
3. **Outlives the render.** `SUB_USAGE_TTL_SECONDS` (default 24h, minimum 1h)
   is refreshed on every write and must stay ≥ `SUB_RENDER_TTL`, so a miss at
   `/sub` means the render's own figure is at least as fresh.

A duplicate delta commits nothing and publishes nothing.

## Live usage for the owner's page (F-307-t)

The same charge tells the Grant's owner its total: `entitlement.grant.usage`
`{tenantId, userId, grantId, consumedBytes}` on the outbox, to the `user:`
channel through worker-service's live-push consumer, and My services raises
the row's figure (`panel-web/contract.my-services.md` 13b). Three rules:

1. **At most once per 30 s per Grant** (`USAGE_PUSH_EVERY_MS`). The slot is
   `grant.usagePushedAt`, claimed by a conditional update on the row the
   charge already holds locked, so two replicas announce once.
2. **In the charge's transaction** (ADR-0021): the event commits or rolls back
   with the bytes it reports. A duplicate delta announces nothing.
3. **The committed total, never a delta.** A push skipped by the window costs
   nothing, because the next one carries it. A window's last bytes wait for the
   Grant's next charge or a reload. With a ~20 s collection pass, pushes land
   about every 40 s (measured on dev, 2026-09-27).

## Usage thresholds (F-601-d)

The same charge tells a prepaid Grant's owner when its usage period crosses 50,
80 or 95 % of its bytes: `entitlement.grant.usage_50` / `_80` / `_95` on the
outbox, a retention event (notification `contract.retention.md`). The rule —
what the share is of, which Grants, which level — is entitlement's
(`contract.md` "Usage thresholds"); `usage-threshold.ts` is its arithmetic.

1. **In the charge's transaction**, after the update that moved
   `consumedBytes`: the row lock orders two replicas' charges, so exactly one
   sees each crossing, and the event commits with the bytes that crossed it.
2. **No window.** Unlike the page's push, a crossing is told on the charge
   that makes it; a duplicate delta commits nothing and tells nothing.
3. **50 and 80 % are held, 95 % is not** (F-601-n): a time level already due
   is told with the crossing, as one event carrying `endNotice`, `endPeriod`,
   `days`, and the end clock moves past it; with none, 50 / 80 % are written
   to the Grant (`usageNoticeLevel`, `usageNoticeSince`) for entitlement's
   sweep. A time level not yet due is never pulled forward (entitlement
   `contract.retention.md` "The 24 h hold").
