---
id: network
layer: domain
status: draft
version: 15
updated: 2026-09-26
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
`regenerate`, which moves no bytes — calls the re-split, which writes nothing
since F-027-db: the lease planner takes a disabled or retired config out of the
split on its next plan, and gives a new one its first share on the woken turn,
before the pass creates its client (`contract.lease.md` rules 5, 18).

| action | writes | refused with |
|---|---|---|
| `provision(tx, {grantId, panelId, protocol, actor})` | a new row: fresh `uuid`, `present`, enabled, `pending`, `remoteId` null | `grant_not_found`, `grant_not_active`, `panel_not_found` |
| `provisionForGroup(tx, {grantId, placements: [{panelId, inboundRemoteId, protocol}], credentialGroupId, actor})` | one such row per placement, carrying its `inboundRemoteId`, under one `credentialGroupId`, one rebalance; a `pending` Grant too — its caller is group fulfilment (`contract.groups.md` rules 8–10, `contract.inbounds.md`) | `grant_not_found`, `grant_not_active` (neither `pending` nor `active`) |
| `regenerate(tx, {configId, actor})` | a fresh `uuid`, `pending`; `regenerateUsedCount + 1` for a `user` actor only — an admin's or the system's is outside the user's cap (F-311-g) | `regenerate_limit_reached` (a `user` actor), `config_changed` |
| `disable(tx, {configId, reason, actor})` | `disabled_by_admin` (or `_by_system`), `desiredEnabled = false`, `disabledReason` | `actor_not_allowed` for a user |
| `enable(tx, {configId, actor})` | `active`; `desiredEnabled` = the Grant is `active` | `actor_not_allowed` for a user |
| `retire(tx, {configId, actor})` | `retired`, `absent`, `desiredEnabled = false`, `pending` | — |
| `drain(tx, {configId, actor})` | as `retire`, plus `drainedAt`: the panel is not held for the Grant (drain sweep only, `contract.groups.md` rules 9, 14) | — |
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

"The panel" below is the client the three-key match found (`remoteId` →
`claimTag` → `uuid`, `contract.drift.md`), and every write goes to that
client's id — a renamed or rebuilt client is re-keyed and carried on.

| desired | the panel | the pass |
|---|---|---|
| `absent` | holds it | `DeleteClient` → `partial` |
| `absent` | holds it under no key | clears `remoteId` → `complete` |
| `present`, no `remoteId` | holds our tag or `uuid` | adopts it (a create whose answer was lost) → `partial` |
| `present`, no `remoteId` | nothing | `CreateClient` under its ceiling → `partial` |
| `present`, `remoteId` | holds it under no key | recreated, as a create — `missing`, a repair under the anti-flap stop (`contract.drift.md`) |
| `present` | rebuilt: our `uuid`, not our tag | `UpdateClient` with the tag and a create's first block → `partial` |
| `present` | `uuid` differs | `UpdateClient` with the new `uuid`, the panel's own ceiling kept → `partial` |
| `present` | `enabled` differs | `SetClientEnabled` → `partial` |
| `present` | matches, under another id | re-keys `remoteId` → `complete` |
| `present` | matches | `complete` |

**`complete` is a read, never our write** — the rule `appliedCeilingBytes`
keeps (invariant 36). That read is also where a config's link lines are
captured, when the row's were read from another client — except a create's,
read in its own pass from the client it returned (`contract.links.md`
rules 6–8, F-027-bj, F-111-k). A write that returned nil is `partial`; only a later read
showing the desired state is `complete`, and only that read clears a deleted
client's `remoteId` (invariant 15). A refused write leaves the row where it was
and is a `write_refused` finding with the driver's fault; the rest of the panel
goes on.

**A client is never created without its ceiling.** The first block is written
with the create, in the new counter's origin — `allocatedCeilingBytes` less the
lifetime bytes the config already served, so a rebuilt client is not handed
the whole share again. No allocation yet is `awaiting_allocation`; nothing left
is `allowance_exhausted`; a config whose inbound (`inboundRemoteId`, else the
lowest picked one of its protocol) is not listed enabled with its protocol, or
that has none, is `no_inbound` — never the first enabled inbound
(`contract.inbounds.md` rule 7). None of the three creates anything. The same
pass writes the panel's inventory of inbounds when it is due (rule 1 there).

**An unlimited config is created with no limit** (F-111-r). `trafficUnlimited`,
copied from its Grant at create, is what was sold, so there is no allocation to
wait for and none to run out of: `CreateClient` goes out with `NoDataLimit`, and
a rebuilt client gets no limit back where a limited one gets its first block.

## One purchase, one account (F-114-n)

Every config of a placement carries one `credentialGroupId` (`provisionForGroup`,
group fulfilment reuses the Grant's), and **its clients on a panel are one
account**: they share a subscription key and are named `<key>-1`, `<key>-2`,
each with its own `uuid` (invariant 1). Reported 2026-09-26 (user): an `all`
purchase showed on x-ui as two unrelated accounts.

- The key is `converge.SubscriptionKey(credentialGroupId)`
  (`internal/converge/account.go`): 16 of `[a-z0-9]` from a SHA-256 of the id —
  derived, never stored, so a pick added later joins the same account; hashed,
  so the id is not readable off the panel. A config of no group gets none.
- A create asks for `CreateClientRequest.SubscriptionKey` and `.Name`. The name
  is the lowest `<key>-<n>` no client of this pass's `ListClients` holds (ours
  or not) and none handed out earlier in the pass; a recreate (`missing`)
  keeps its `remoteId` while it is free. Only a create names a client —
  existing clients are never renamed, since the name keys their counters.
- **Honoured by alireza0 and 3x-ui v2 (`sanaee`) only**: key → `subId`, name →
  `email` (`contract.xui.md`). Every other family ignores both. 3x-ui v3
  (`three_x_ui`) is left out on purpose: its lines are read off the sub server
  by `subId` (`contract.links.md`), so a shared one would hand every sibling's
  lines to each config.

**Staging.** Desired state is read through `converge.Desired` and shares
through `converge.Allocations`; `PostgresDesired` and `PostgresAllocations`
(`internal/converge/postgres.go`, F-027-bo) are both over `network.config`, and
`MemoryDesired` / `MemoryAllocations` stay as what the pass is proved against.
A pass reads every row on its panel except a delete already confirmed
(`absent`, no `remoteId`, `complete`); served bytes are the counter cursor's
lifetime figure. **An outcome is recorded only over the desired state it was
judged against** — `uuid`, `desiredEnabled` (false too while the lease
planner holds the Grant closed, `contract.lease.md` rule 24), `desiredRemote`
in the update's `where` — so an action landing mid-pass leaves no row to update, and a
`complete` nobody checked is never written (group fulfilment activates on it).
The pass runs in each collected panel's turn, started in `cmd` with the loop
(`contract.collection.md` "Running it", F-027-bt). Every row has a `claimTag` (NOT NULL, F-027-aa), and it goes
out with every create and update.
