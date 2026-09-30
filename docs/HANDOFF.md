---
id: handoff
status: active           # empty | active
item: F-027-dx           # the backlog id currently mid-flight
updated: 2026-09-30
---

# Handoff — the state a fresh session cannot recover on its own

Written when a session ends **mid-item**, and read as the first thing in the
next one. It is not a log: it is **overwritten every time**, and reset to
`status: empty` the moment the item flips to `done`. A handoff file that
outlives its item is worse than no handoff — the next session will trust it.

**Do not repeat anything that lives elsewhere.** The backlog says what the item
is. `MASTER_INDEX.md` says which unit owns it. `spec.py` says what it must do.
The code says what exists. This file holds only the four things that die with
the session:

1. what is half-written right now
2. the next concrete step
3. what was already tried and failed
4. what you and the agent decided out loud but never wrote down

If a session ended cleanly — item `done`, or never started — this file stays
`empty` and `/next` resumes with no help from it.

---

## Item

`F-027-dx` · unit `network` · spec: the row's note (no catalog id)

## Where it stands

Nothing committed; the working tree was reverted. The approach below passes
`internal/lease/quota` and `internal/lease/sim` (bursty scenario back inside
[-8,5]%) but fails `leaseplan` `TestAShareMovesOnlyThroughWhatIsFree`
(seeds 1 and 9: used + room > quota right after a settle-reopen).

## Files touched, and their state

| file | state |
|---|---|
| `network-service/internal/lease/quota/planner.go` | reverted. The attempt, in `Account.Plan` before the close check: `settled := a.closeWatched && a.Used == a.closedUsed && every v: v.r.LimitPeak <= v.r.LimitSeen && v.r.effAt.After(a.closedAt.Add(v.lag))`; `renewed := Quota or end moved`; reopen when `!expired && avail >= reopenAt && (renewed \|\| settled)`, `reopenAt = ReopenMin` on a renewal, else `max(ReopenMin, FinishMin, Σ vDem × FinishTime)`. Set `closeWatched, closedAt` where the close is taken; `closedUsed = Used` on every plan that stays closed |
| `network-service/internal/lease/quota/types.go`, `persist.go` | reverted. `closeWatched bool`, `closedUsed Bytes`, `closedAt time.Time` on `Account`; `RestoreClosed` sets `closeWatched = false` (a restored close still waits for a renewal — the old test's restart guarantee holds) |
| `network-service/internal/leaseplan/close_test.go` | reverted. `TestACloseWithBytesLeftReopensOnceItSettles`: 64 MB bench, two replicas at 20 MB/turn closes with ~10 MB left (blocked branch); `turn(nil)` up to 20 times must reopen and enable a config |

## The next concrete step

Decide whether the `TestAShareMovesOnlyThroughWhatIsFree` breach is real: the
bench has no enable flag (`exposure()` counts a disabled config's room) and
`emit` resets `LimitPeak` when re-enabling a dead replica. Model enable in the
bench, or prove the reopen write lands after every older one, before touching
the rule again.

## Dead ends — do not retry

| tried | why it failed |
|---|---|
| reopen on `avail ≥ ReopenMin` alone | sim over +6.45% (1 GB/5 devices, bursty): bytes in flight read as avail |
| settle = all replicas `!enabled && !active` | a blocked replica keeps its rate, so it never settles |
| settle = `Used` unchanged for a turn + read after close+lag | bursty sim +6.45%: 68 MB left at 20 MB/s reopened into a 132 MB overshoot — hence the `Σ vDem × FinishTime` threshold |
| settle on `LimitSeen == LimitWant` | an older in-flight write with a higher limit still pending; use `LimitPeak` |

## Decided in conversation, not yet written down

| decision | where it must land |
|---|---|
| User 2026-09-30: stranded paid bytes are fixed by reopening on its own, not by a refund only | lease-close rule 25, when this lands |
| A prepaid (package) Grant closed on the same blocked branch is suspended `quota_exhausted` by billing at once, bytes left — the planner's reopen never reaches it (it reads active/pending only) | user 2026-09-30: a close-reason column — row F-027-dz |
