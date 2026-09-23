---
id: network
layer: domain
status: draft
version: 12
updated: 2026-09-23
---

# Provisioning — every action is desired state, and one pass carries it

What governs creating, regenerating, enabling, disabling, moving and deleting a
config (F-027-z, ADR-0075). Read it before adding an action on a config, before
writing `desiredEnabled`, `desiredRemote`, `status` or `uuid` from anywhere
new, and before calling any client-lifecycle method of a `Driver`.

**Nothing calls a panel except the convergence pass.** An action writes the
config's desired state and returns; `network-service/internal/converge`
compares that state **as it is when it looks** against what the panel reports,
and writes the difference. A change made twice is one change, a change undone
before the pass arrives is no change, and a top-up that lands mid-purge rebuilds
the client instead of racing the delete. The one exception is operator repair
on a panel (`ResetUsage`), which is not an action on a config.

## The writers — `ConfigActionsService` (billing-service)

`billing-service/src/app/traffic/config-actions.ts`, in-process, every method in
the caller's transaction. Each writes one `config_action_log` row and — except
`regenerate`, which moves no bytes — rebalances the Grant's ceilings in the same
transaction (`contract.ceiling.md`): a disabled or retired config leaves the
split, and a new one has its share before the pass creates its client.

| action | writes | refused with |
|---|---|---|
| `provision(tx, {grantId, panelId, protocol, actor})` | a new row: fresh `uuid`, `present`, enabled, `pending`, `remoteId` null | `grant_not_found`, `grant_not_active`, `panel_not_found` |
| `regenerate(tx, {configId, actor})` | a fresh `uuid`, `regenerateUsedCount + 1`, `pending` | `regenerate_limit_reached`, `config_changed` |
| `disable(tx, {configId, reason, actor})` | `disabled_by_admin` (or `_by_system`), `desiredEnabled = false`, `disabledReason` | `actor_not_allowed` for a user |
| `enable(tx, {configId, actor})` | `active`; `desiredEnabled` = the Grant is `active` | `actor_not_allowed` for a user |
| `retire(tx, {configId, actor})` | `retired`, `absent`, `desiredEnabled = false`, `pending` | — |
| `move(tx, {configId, toPanelId, actor})` | the old row retired (`move_out`), then `provision` on the target | `same_panel`, `panel_not_found` |

Every action on an existing row refuses `config_not_found` (unknown, or another
user's — a user actor acts only on their own) and `config_retired`.

**The regenerate limit is held in the write** (invariant 4): the update's
`where` carries the count it read, so two regenerates racing each other cannot
both pass a check made before either wrote. The loser is `config_changed`,
never a second rotation. Every other write is conditional on the `status` it
read, for the same reason.

**A user cannot disable.** A user who wants a config gone retires it. A
user-level pause would need a status of its own: the top-up that revives a
Grant sets `active` configs enabled, and would silently undo it.

**Enable does not outrank the Grant.** A config enabled under a suspended Grant
is `active` and still off; the revive turns it on.

## Retired is not purged

A delete and a purge (F-027-y) both write `desiredRemote = absent`. A purge is
temporary — a top-up restores it — and a delete is not, so `status = retired` is
the difference: CHECK `config_retired_is_absent` holds the pair, and
`reviveOnTopUp` restores only `status = active` configs, which also stops it
re-enabling one an admin disabled. The row is never deleted.

## A move is a new row

The old row retires and a new one is provisioned on the target panel with a
fresh `uuid` — never a rewrite of `panelId`. The counter cursor, the traffic
history and `(panelId, remoteId)` all belong to one panel; a row that changed
panel would compare the new panel's counter against the old one's cursor. The
old client holds the old `uuid` until it is deleted, and `uuid` is unique
system-wide. The Grant's subscription link follows; a copied single-config link
does not.

## The pass — `converge.Provisioning` (network-service)

`internal/converge/provision.go`. `converge.Converger` is the collection pass's
converger: **one** `ListClients` per panel, then provisioning, then the ceiling
pass over the same read (invariant 34) — minus the clients provisioning just
deleted, so a stale share is never written to a client that is gone.

| desired | the panel | the pass |
|---|---|---|
| `absent` | holds `remoteId` | `DeleteClient` → `partial` |
| `absent` | does not | clears `remoteId` → `complete` |
| `present`, no `remoteId` | a client holds our `uuid` | adopts it (a create whose answer was lost) → `partial` |
| `present`, no `remoteId` | nothing | `CreateClient` under its ceiling → `partial` |
| `present`, `remoteId` | does not hold it | skipped — F-027-aa's verdict |
| `present` | `uuid` differs | `UpdateClient` with the new `uuid`, the panel's own ceiling kept → `partial` |
| `present` | `enabled` differs | `SetClientEnabled` → `partial` |
| `present` | matches | `complete` |

**`complete` is a read, never our write** — the rule `appliedCeilingBytes`
keeps (invariant 36). A write that returned nil is `partial`; only a later read
showing the desired state is `complete`, and only that read clears a deleted
client's `remoteId` (invariant 15). A refused write leaves the row where it was
and is a `write_refused` finding with the driver's fault; the rest of the panel
goes on.

**A client is never created without its ceiling.** The first block is written
with the create, in the new counter's origin — `allocatedCeilingBytes` less the
lifetime bytes the config already served, so a rebuilt client is not handed
the whole share again. No allocation yet is `awaiting_allocation`; nothing left
is `allowance_exhausted`; a panel with no enabled inbound for the protocol is
`no_inbound`. None of the three creates anything.

**Staging.** Desired state is read through `converge.Desired`, proved against
`MemoryDesired` — the same staging `MemoryAllocations` is in until
`network.config` is read directly. `claimTag` is carried when the row has one;
writing it on every config is F-027-aa's.
