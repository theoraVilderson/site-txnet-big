---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-27
---

# The ceiling — one bag, split across the configs that draw on it

What governs how much of a Grant's purchased bytes each of its configs may
carry, and the pass that carries it to the panel. **The share is the lease
planner's alone** (F-027-db, ADR-0093): `leaseplan.Planner` is the only writer
of `config.allocatedCeilingBytes`, sized and written as
[contract.lease.md](contract.lease.md) says. Billing's split
(`CeilingAllocatorService`, F-027-s) is gone since F-027-dk, and nothing in
`billing-service` sizes a share. Read this before adding a writer of that
column, or giving a config a ceiling from anywhere else.

**`Σ ceilings ≤ Quota`, across every config of a Grant** (entitlement
invariant 8). Quota is `purchasedBytes`, plus the wallet's reserve on a metered
Grant ([contract.reserve.md](contract.reserve.md)). One bag over five panels
needs one ceiling split five ways; five full ceilings would serve five times
what was bought, and each one would look correct on the panel it sits on. That
is why the planner's split is proved over a moving consumer and restarts
(`leaseplan/lease_test.go`), not by three cases.

## What is split, and by whom

| | |
|---|---|
| the bag | `purchasedBytes` — advanced only by `BlockPurchaseService`, in the transaction that debits the wallet (billing `contract.traffic-block.md`) |
| the reserve | on a metered Grant, its even share of what the balance still buys at its rate (F-027-dt); part of Quota since F-027-dc |
| a share | `allocatedCeilingBytes`, the planner's, in lifetime bytes; grown only from what is free, a shrink freed only once the panel confirms it (`contract.lease.md` rules 16–19) |
| the shutdown figure | `walletBackedCeilingBytes`, the planner's, equal to the share ([contract.resilience.md](contract.resilience.md)) |
| a new block | the planner's request, bought by billing's `traffic/block-request.ts` (`contract.lease.md` rules 20–23) |

A config action (provision, disable, retire, move) writes desired state and
sizes nothing: the planner gives a new config its first ceiling before the
pass creates its client (`contract.lease.md` rule 5), and a config that leaves
the split is dropped on its next turn.

## Lifetime bytes, not the panel's counter

A share is counted in **lifetime bytes for that config** — what it has carried
since it existed, across resets (`ConfigCounterState.lifetimeUpBytes +
lifetimeDownBytes`), which is the basis `purchasedBytes` is counted on. A
config with no counter row has served nothing.

The panel's own counter is a different number: it starts at zero after a backup
restore, and turning a lifetime allowance into the figure that counter needs
today is the convergence loop's, in the same pass that sees the reset. ADR-0072
names that rewrite as the thing without which a reset button is a way around
the decision.

## Who is in the split

Only configs that can carry traffic: `status = active` with
`desiredEnabled = true` and `desiredRemote = present`. A disabled or purged
config holding a share would be bytes the bag has spent that no panel can
serve, and the user would read it as a bag emptying while they are offline.

**An unlimited Grant has no split at all** (F-111-q). Its `purchasedBytes` is 0
by construction and `trafficUnlimited` says why; the planner never loads it
(`leaseplan/postgres.go`) — split, a 0 bag would hand every config a 0-byte
ceiling. Its configs keep `allocatedCeilingBytes = null` (CHECK
`config_unlimited_has_no_ceiling`), so no pass reads them, and a client with no
limit is never taken for `no_limit_on_panel`: provisioning creates it that way
(F-111-r).

**A sub-account cap is not held today.** Billing's split cut a config carrying
an active `billing.SubAccount` to its `dataCapBytes` (F-608); the planner reads
no such cap. Nothing writes `sub_account` yet, so no config carries one —
`open-questions.md` has the row for when F-608 is built.

## The convergence loop — carrying the number to the panel (F-027-t)

`network-service/internal/converge` is the other half: the planner's number
is ours until a panel is enforcing it, and the panel is the enforcement point
that keeps working while this service is down. It runs at the end of each
panel's turn in the collection pass (`collect.PassConverger`) — and on a woken
turn seconds after the planner moves a share (F-027-cp, `contract.collection.md`
rule 5), so a re-split is not a 60 s cut mid-download — costs **one**
`ListClients` for the whole population, and writes `SetClientDataLimit` only to
the configs that disagree — shrinks first, then nearest crossing
(`contract.lease.md` rule 19, `contract.budget.md`).

**`applied` is what the panel confirmed, never what we sent.** Families take a
ceiling late, so a write that returned `nil` is not a ceiling being enforced,
and a believed ceiling is worse than a missing one — the traffic past it is
served with nothing red anywhere. `appliedCeilingBytes` is therefore read back
off `ListClients` and set with `ceilingAppliedAt` in the same write
(invariant 14). A panel reporting **zero** confirms nothing: zero read means
*no limit* there, so it is never recorded as an applied ceiling.
The write locks its rows in id order, as the planner's lease write does, or the two
deadlock and the pass's confirmations are lost (invariant 54, F-027-cv).

### From a lifetime allowance to the figure that counter needs today

An allocation is counted in lifetime bytes; a panel enforces against its own
counter, which a restore or an operator can zero. So the panel figure is

```
offset  = max(0, lifetime bytes served - what the counter reads now)
ceiling = max(0, allocatedCeilingBytes - offset)
```

and "what the counter reads now" is the raw figure under `cumulative`, and zero
under `reset_on_read` (the read spent it) and `session` (the panel counts per
session, so there is nothing to subtract) — the conservative reading in both.

**The translation only ever lowers** — that is what the two `max`es are for,
and it is why `Σ ceilings ≤ purchasedBytes` survives it. Bytes the far end's
counter holds that we never billed — a baseline adopted when we started
watching, a figure the plausibility cap quarantined — get **no** headroom.
Covering them would serve traffic against nobody's purchase; refusing to is a
user who stalls, which is ADR-0072's accepted worst failure in every direction.

### No guard band on the planner's figure (F-027-db)

F-027-co took the panel's lag off the share (`rate × lag`, near the cut only).
The planner's invariant already holds that lag, so the pass and provisioning's
first ceiling write the share as it is (`contract.lease.md` rule 19); a band
here would pay the lag twice and leave a panel enforcing a figure the planner
never wrote, which never reads as landed. The band (`NearBand`,
`GuardedAllowance`) rides only on the shutdown extension
(`contract.resilience.md`). Overrun stays uncharged.

### What a write says about itself

Every write is a `Finding` with a reason, because each is a different thing to
do about it: `counter_reset` (this pass saw the counter go backward, which is
the reason the loop exists), `above_allocation` (ADR-0072 rule 2 — a money
hole, overwritten immediately and past the anti-flap stop, `contract.drift.md`),
`below_allocation` (their number only shortens the user's service: rewritten,
and reported rather than treated as an emergency), `no_limit_on_panel`,
`allowance_exhausted` and `write_refused`.

The reset is read off the cursor's own reset mark and not off the delta stream:
a counter zeroed between two reads publishes **no delta at all** — the
post-reset figure can be zero — and that is exactly the case the rewrite exists
for.

`allowance_exhausted` is a ceiling of zero, and it is rewritten every pass
rather than converged, because a panel cannot confirm zero back. Cutting the
user off for real is the Grant suspension (F-027-x) and `desiredEnabled`
(F-027-z), not this number.

### What it will not do

It writes one number and reads it back. Sizing a share is the planner's,
creating or enabling a client is F-027-z's, deciding which config a remote
client belongs to is F-027-aa's. It holds one write the anti-flap stop bounds
— raising a ceiling somebody else lowered, `ReasonContested` — and never a
lowering (`contract.drift.md`). A config whose `remoteId` names no client on the panel
is skipped here and gets its verdict there (`contract.drift.md`).

It does flag one verdict: a drift write whose panel figure is neither the
`appliedCeilingBytes` it last confirmed (`Allocation.AppliedBytes`) nor the
`writtenCeilingBytes` we last wrote and it accepted (`Allocation.WrittenBytes`,
F-027-cu) is `Finding.Overridden` — `limit_overridden`. A top-up is not: the
panel still holds a figure of ours, stale. `writtenCeilingBytes` is never a
confirmation — nothing enforces from it — only what tells ours from theirs.
