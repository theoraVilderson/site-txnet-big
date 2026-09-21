---
id: adr-0075
status: active
updated: 2026-09-21
---

# ADR 0075 — an exhausted Grant suspends, and its clients are purged on a clock

- **Status:** accepted
- **Date:** 2026-09-21
- **Affects units:** entitlement, network, billing, tenant

## Context

Nothing in the platform moves a Grant out of `active` today.
`GrantService.transition` has zero production callers, `billedBytes` is never
read or written, and no sweeper exists. The behaviour has to be chosen from
scratch, and two existing constraints narrow it sharply.

**The status machine is one-way, by database trigger.**
`grant_status_one_way` allows `active → suspended | exhausted | expired |
cancelled`, and **only `suspended → active` comes back**. `exhausted` is a dead
end. So a Grant put into `exhausted` when its quota runs out can never be
revived by a top-up — the database forbids it. The obvious-sounding status is
the wrong one.

**Catalog §7.10 specifies a grace window that ADR-0072 makes meaningless.** It
says a metered Grant whose wallet hits zero enters `grace` for 10 minutes, then
suspends. That window *is* the free-traffic hole: ten minutes at line rate is
several gigabytes given away per occurrence. Under ADR-0072 the ceiling has
already stopped the user at the last byte they paid for, so there is nothing
left for a grace period to protect.

The user's requirement (2026-09-21) is that when volume runs out, accounts are
**first disabled** across every panel, and **deleted after a while** — panels
have user counts and licences, and dead clients occupy them.

## Decision

**Quota exhaustion suspends.** A Grant whose bag is empty and whose wallet
cannot fund the next block moves to `suspended` with
`statusReason = 'quota_exhausted'` and `suspendedAt = now`, and every config of
that Grant gets `desiredEnabled = false` on every panel it lives on. `exhausted`
is reserved for a Grant that is genuinely finished and will not be revived — a
prepaid package whose replacement is a **new** Grant.

**Purge is a second, timed stage.** After `purgeAfterDays` (default 7, a tenant
setting; `0` means never), every config of a suspended Grant gets
`desiredRemote = absent` and the remote client is deleted, freeing the panel's
seat. **Our rows are never deleted** — the `Config` row stays with `remoteId`
cleared, because the desired state is the only thing that makes rebuilding a
button rather than an operation.

**Disable, purge and restore are all desired state, never queued commands.**
The convergence loop always compares the desired state *as it is now* against
what the panel reports. It never replays an instruction. This is the rule that
makes the obvious race safe:

```
10:00  purge becomes due; the panel is unreachable
11:00  the user tops up  -> desired state is "present and enabled"
12:00  the panel returns -> the loop converges on the CURRENT desired state
                            and creates the client. Nothing is deleted.
```

A top-up returns the Grant to `active` from either stage — re-enabled if
merely suspended, rebuilt from desired state if purged.

**Catalog §7.10's 10-minute metered grace is not implemented.** This is a
deliberate, recorded departure from the spec text.

## Consequences

- Positive: a top-up revives service at any point, which the `exhausted` reading
  of the spec would have made impossible at the database level.
- Positive: panel seats are reclaimed on a predictable clock, without anyone
  having to remember to do it.
- Positive: because our rows survive, a rebuild is one button and produces a
  fresh `uuid` with the subscription link updated automatically — the user does
  not have to be told to reconfigure anything.
- Positive: the no-replay rule removes a whole class of race, including the
  worst one — deleting the account of a user who has just paid.
- Negative / accepted cost: **a departure from catalog §7.10.** Anyone reading
  the spec will expect a 10-minute grace and not find one. This ADR is where
  that is recorded; the catalog text is not edited, because it is a fixed file.
- Negative / accepted cost: `suspended` now carries two distinct meanings — out
  of quota, and suspended by an admin or a tenant status change.
  `statusReason` separates them and every reader must consult it.
- Negative / accepted cost: a purge on an unreachable panel stays `pending`
  indefinitely. The Grant reports `purged` only when enforcement is `complete`
  everywhere, so partial states are visible rather than silently rounded off.
- Negative / accepted cost: `purgeAfterDays = 0` lets a tenant accumulate dead
  clients forever. That is their choice, and the drift report counts them.
- What this forecloses: treating a status transition as a fire-and-forget
  command anywhere in this plane, and deleting our own rows to reflect a remote
  deletion.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| `exhausted` on quota exhaustion | the trigger makes it terminal. The user's requirement — top up and come back — would be unimplementable without changing a database constraint that exists to keep the lifecycle honest |
| Implement §7.10's 10-minute metered grace | it is the free-traffic window ADR-0072 exists to close, and with a ceiling in place it protects nothing: the user has already stopped at the last byte they paid for |
| Never delete remote clients, only disable | panels have user counts and licences, and dead clients consume them. It also leaves the customer's panel filling with names nobody recognises |
| Delete our `Config` rows on purge | rebuilding would then be a reconstruction rather than a button, and the history of what a user held would be gone. Desired state is the only thing that makes recovery cheap |
| Queue the purge as a command with a timestamp | the race above. A command issued before a top-up and executed after it deletes a paying user's account, and no amount of ordering fixes that as reliably as not having a command |
| Relax the one-way trigger so `exhausted` can return | it would let any status go backwards for everyone, to avoid picking the right status here |

## Revisit trigger

Either of:

- F-603 (the 24-hour post-expiry grace) is built. Catalog §7.10 says it applies
  to **every** Grant type, not just metered ones, so it interacts with this
  timeline and the two must be reconciled deliberately.
- Purge timing proves wrong in practice — tenants routinely setting
  `purgeAfterDays = 0`, or users routinely returning after the window and
  finding their configs gone.
