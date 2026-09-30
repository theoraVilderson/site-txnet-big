---
id: network
layer: domain
status: draft
version: 3
updated: 2026-09-30
---

# Close by disable — when the planner closes a Grant, and what reopens it

What governs `network.lease_close` and the planner's close
(`network-service/internal/lease/quota` `Account.Plan`, F-027-dd, SPEC §6-2).
Read it before changing when a Grant is closed or reopened, or what billing
is told about it. Split out of [contract.lease.md](contract.lease.md) on
2026-09-30; the rule numbers are that file's and did not change.

24. **A closed Grant is disabled, not only capped.** The planner closes a
    Grant when it has expired, when `Quota − Used ≤ 0`, or when every active
    replica is blocked and `avail < max(FinishMin, ΣvNow × FinishTime)` —
    never on `avail ≤ 0` alone, which is only the rest being eaten inside the
    panel's lag (SPEC weakness #7). The close is a row on
    `network.lease_close` — the Quota and end it closed on — written by the
    planner alone. While it stands, the convergence pass desires every config
    of the Grant disabled (`desiredEnabled AND NOT EXISTS lease_close`, the
    same test in its record guard), so the panel drops the client at once
    rather than a tick after its counter meets the ceiling; the ceiling is
    still written at the counter beside it. The shutdown extension skips a
    closed Grant. `desiredEnabled` stays billing's. The close is announced in its own statement (`network.grant.closed`,
    ADR-0096): billing suspends a prepaid Grant on it, and a renewal revives it.
    **A close says why** (`lease_close.reason`, F-027-dz, user 2026-09-30):
    `ended` when the end has passed, else `spent` when `Quota − Used ≤ 0`,
    else `guard` — the blocked-replica branch, bytes still paid. Billing
    suspends a prepaid Grant only on `spent` or `ended`; a guard close is
    left to reopen as rule 25 says. The reason moves with the Grant while
    the close stands — a guard close whose rest the panels' lag served
    becomes `spent`, and any close whose end comes becomes `ended`, even an
    end that did not move — and the row is written again, so billing is
    asked again. Rows from before the column read `ended` if closed on or
    past their end, else `spent`, as billing had already read them.
    **An end that passes on a Grant already closed moves the close to that
    end** (F-027-dy): the row is written again, so the close is announced
    again and billing suspends it `period_ended` (purge clock, close,
    remainder). A close taken on bytes otherwise kept the old end for good.
25. **A renewal reopens it, and so does a close with bytes left once it has
    settled** (F-027-dx, user 2026-09-30: stranded paid bytes are served,
    not only refunded). A renewal — Quota or the end moved since the close —
    reopens at `avail ≥ ReopenMin` (8 MB). Without one, a close this process
    took reopens once it has settled: Used unchanged since the last plan that
    kept it, every close write landed (none pending, the panel showing the
    figure written — for a written 0, the one byte every family stores it
    as, `quota.CutOffBytes`, F-027-eb), every reading from a panel tick past the close plus
    that panel's lag, and `avail ≥ max(ReopenMin, FinishMin, ΣvDem ×
    FinishTime)` — enough to finish on at the demand that closed it, or it
    closes again at once. Either way, a figure written before the close and
    still in flight counts against avail (`Replica.closePeak`): the close
    writes the counter, which the panel may already show, so a reading of it
    cannot prove the older write landed; the figure is held until a reading
    shows it or more. The close row is deleted silently, as on a renewal.
    A process restarted onto a closed Grant restores the close from the row
    (`Account.RestoreClosed`) — forgetting is never a reopen. A `spent` or
    `ended` one waits for a renewal; a `guard` one, which billing does not
    suspend, is watched from its first plan after the restore and reopens
    once it settles as above, with every figure the row still shows in
    flight held (F-027-ea); a close row that cannot be written drops the account, and the
    next turn restores it from what was written. A prepaid Grant billing
    suspended on the close is not read again by the planner (F-027-dz). A
    disabled client on 3x-ui is `RemoveUser`'d, which keeps its open
    connections unless the panel restarts Xray on disable (F-027-cm,
    open-questions 2026-09-26).
