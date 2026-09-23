---
id: network
layer: domain
status: draft
version: 10
updated: 2026-09-22
---

# The request budget, and what a refusal means

A topic file of `contract.md` (§10). What governs `driver.Pace`,
`collect.Paced` and `network-service/internal/panelstate` (F-027-k, F-027-v):
how often a panel may be asked, what happens when it says no, and the rate each
pass writes back. Read it before changing a budget, a cool-off, or the meaning
of a fault kind.

**Every rule here is about somebody else's server.** A panel is a machine we do
not own, usually the customer's own, and our collector is a program that talks
to it once a minute for ever. The failure this file exists to prevent has no
wrong number in it: every byte correct, and the customer's server flooded or
our address banned (catalog 8.4, invariant 34).

## The budget is the panel's own figure

`panel.maxRequestsPerMinute` is the panel owner's answer to how often we may
ask, and `collect.Paced` is the one place it becomes behaviour: it wraps the
family's driver in `driver.Pace` with a `Budget` built from the row. A loop
holding every panel to a constant of its own would be holding them to a figure
nobody agreed to.

Two properties come with the wrapper and neither is a family's to reimplement:

- **A whole-panel read is shared.** Concurrent callers wanting the same read
  get one request — which is exactly when a slow panel would otherwise be
  flooded by the callers waiting on it. It is single-flight and not a cache: a
  caller arriving after the flight lands gets a fresh read, because a figure
  served from memory is one nobody measured at the moment it was billed.
- **A call over the budget waits for its slot, and never fails.** A dropped
  read is a hole in a counter somebody is charged from (invariant 18), and the
  panel would have answered it a moment later.

`Paced` panics on a non-positive budget rather than picking a reading of it.
The column is CHECKed positive (invariant 12), so a zero is the constraint
having been bypassed, and the two readings available — *ask without limit* and
*never ask again* — are both worse when found later.

## A refusal is not a failure

`429` and `403` arrive the same way a `5xx` does and mean the opposite thing.
A refusal is a **working** panel declining us; a `5xx` is a panel that is
broken. `network.PanelState` has a name for each, `internal/panelstate` is the
only thing that sets them, and `Judge` is total over the fault kinds so a kind
added later cannot fall through to "nothing happened":

| fault kind | state | what the loops do |
|---|---|---|
| `rate_limited`, `blocked` | `throttled_or_blocked` | not asked again until the cool-off has run; the owner is alerted once |
| `unavailable` | `down` | read again on the very next pass — nothing is gained by waiting on a broken machine |
| `unsupported`, `protocol` | `degraded` | it answered and we cannot act on the answer: a panel to look at, not one to stop asking |
| `timeout` | unchanged | our own deadline implicates the panel in nothing |
| not a `driver.Fault` | unchanged | a failed publish or cursor write is ours, not the far end's |

A clean pass is `healthy`, and that is the only evidence a refusal is over.

## The ban carries a clock, and the clock is not restarted

`blockedSince` is set exactly while the state is `throttled_or_blocked`
(invariant 11). It is set **once**, when the refusal starts, and a pass that
finds the panel still refusing leaves it where it is — a clock restarted every
minute is a cool-off that can never elapse, which is a permanent ban by
arithmetic rather than by decision.

- **`DefaultCooloff` is 15 minutes**: long enough that a rate limit measured in
  minutes has expired, short enough that a rotated credential is picked up
  within a service call rather than a working day.
- **The panel's own `Retry-After` is honoured where it gave one, and may only
  lengthen the wait.** A panel asking for an hour gets an hour; it is never
  allowed to shorten ours.
- **The owner is alerted once per ban**, on the transition in. A refusal is a
  thing a person has to act on — rotate a credential, unban an address, raise a
  budget — and a pass a minute would otherwise be an alert a minute. Where that
  alert is delivered, and to the tenant or the platform (invariant 9), is the
  notification domain's.
- **A ban the database did not take is not held.** The write happens first, and
  a failed write leaves the tracker where it was, because a ban only this
  process knows about is invisible to everything else.

Both loops gate on it — the bulk pass and the hot one. The hot loop matters
most here: it runs every two seconds, so retrying through a ban from there is
the fastest way to make the ban permanent. A skipped panel is a `PanelFailure`
row with `Op: skipped`, never a silent absence.

## The rate a pass measured

`config.observedRateBps` is written from the pass that measured it, in bits per
second because everything read from it is in seconds — membership, the hot
interval and the size of the next block (`contract.hot-loop.md`). The window is
the gap since that counter was last read, so the samples are taken **before**
`Cursors.Apply` moves the cursor past the window's start.

Three readings produce no sample rather than a wrong one:

| | |
|---|---|
| **no cursor yet** | the adopting pass has nothing to measure from; billing starts where watching started |
| **a window of zero or less** | a rate over no time is not a large rate |
| **a delta that followed a reset** | the bytes are real, but whatever ran between the last reading and the reset is not in them. A rate read off it understates the line, and an understated rate sizes a block the user has already outrun. The last rate we did measure is left standing |

Recording is not a condition of the pass. It runs after the publish and the
cursor move, and a failure is logged: the bytes are billed by then, and failing
would re-read and republish traffic already charged to fix a figure the next
pass rewrites anyway.

## What it will not do

It does not back off below the panel's declared budget on a `429` — the budget
is the agreement, and a panel that refuses inside its own figure is one to tell
its owner about rather than to negotiate with silently. It does not extend a
ceiling on shutdown or run the collector's watchdog: that is
[contract.resilience.md](contract.resilience.md) (F-027-w). And it
does not decide the rate the **next block** is sized at, which extrapolates up
but never down on the money side (`contract.hot-loop.md`).
