---
id: adr-0167
status: accepted
updated: 2026-10-27
---

# ADR 0167 — A turn creates a bounded number of clients; the waker carries the rest

- **Status:** accepted (built by F-027-fj)
- **Date:** 2026-10-27
- **Decision:** the user's (2026-10-27), choosing "separate building from collection" over a per-pass time budget
- **Affects units:** network (`contract.provisioning.md` "The pass", `internal/converge`, `cmd/server` wiring)
- **Amends:** ADR-0072's "convergence rides the same turn" for creates only; F-111-j's waker gains a second caller

## Context

Provisioning runs inside a panel's collection turn, and the bulk pass waits
for every turn before the next begins. A create is the one write with no
bound: ~2 s on a Marzban of a few hundred users. On the LIVE-1 run a reseller
imported 400 users onto a four-inbound group — 1600 creates on one panel —
and that one turn held the pass for about an hour. No panel of any reseller
was collected meanwhile: no usage billed, no cut-off, no renewal reopened.
The same shape ran seven minutes for a 201-user import the day before, unseen.

## Decision

1. **A turn makes at most `MaxCreates` creates** (`DefaultMaxCreates` = 10),
   and none once `CreateWindow` (10 s) has passed since its first — which is
   always made, so a backlog always moves. A create or a recreate counts only
   when it reaches the panel; one skipped for no allowance or no inbound
   spends nothing. The window was added the same day, live: at 1100 users on
   a loaded disk a Marzban create took 4–9 s, so ten held the pass 45–95 s.
2. **The rest are deferred, not failed.** No outcome is recorded, the row
   stays as it was, and the next turn reaches it.
3. **A turn that deferred asks for another** (`Converger.Owe` →
   `collect.Waker.Wake`): convergence-only turns, under the panel's turn lock,
   gated by its health, chained until one defers nothing. The waker's minimum
   gap is between starts, so a backlog drains at about the panel's own speed.
4. **Never deferred:** deletes, enables, disables, credential and limit
   updates, ceilings. A cut-off is a disable and never waits behind creates.

## Consequences

- The bulk pass waits on one bounded turn per panel at most (about the
  window plus one create, whatever the panel's speed), so usage and cut-off
  keep their minute cadence through a migration.
- A purchase's few configs are still created in the turn its wake runs.
- A backlog survives a restart: the first bulk pass defers again and owes the
  turn again; nothing is kept in memory but the waker's arm.
- Woken turns are not bounded across panels: a hundred panels with backlogs
  are a hundred chains, each one panel's lock at a time.

## Amendment 2026-10-28 (user, F-027-fk): deletes, and a panel that stops answering

A move left 350 deletes on one Marzban. One turn tried them all; the first
timed out, the driver's breaker opened, the other ~345 failed at once, and the
open breaker then stopped the panel's usage read. Decision: the budget covers
every slow write — deletes as well as creates (`MaxWrites`, `WriteWindow`) —
and a turn stops writing at the first sign that the panel gave no answer
(timeout, 429, open circuit, no status): `Stalled`, the rest left as they are,
no woken turn, the bulk pass retries. A 5xx with a status is one client's
refusal and does not stall the turn, or a poison row would block the panel.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A time budget per bulk turn, the rest next pass | the pass still grows with every panel in backlog, and a backlog drains at one budget per minute |
| A provisioning loop of its own, apart from the waker | a second scheduler for what the waker already does: one panel's convergence turn, on demand, under its lock |
| Raise the panel timeout | moves the hour, does not remove it |

## Revisit trigger

Panels in backlog at once outnumber what the node can drive (woken chains
then need a bound of their own), or a family whose create is cheap enough that
the budget is the bottleneck rather than the panel.
