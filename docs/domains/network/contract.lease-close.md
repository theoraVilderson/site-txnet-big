---
id: network
layer: domain
status: draft
version: 1
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
25. **Only a renewal reopens it**: Quota or the end moved since the close,
    and `avail ≥ ReopenMin` (8 MB). A process restarted onto a closed Grant
    restores the close from the row (`Account.RestoreClosed`), so forgetting
    is never a reopen; a close row that cannot be written drops the account,
    and the next turn restores it from what was written. A disabled client
    on 3x-ui is `RemoveUser`'d, which keeps its open connections unless the
    panel restarts Xray on disable (F-027-cm, open-questions 2026-09-26).
