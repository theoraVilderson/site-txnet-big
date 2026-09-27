---
id: network
layer: domain
status: draft
version: 6
updated: 2026-09-27
---

# The lease planner's state — what it learns, and where it keeps it

What governs the storage behind `network-service/internal/lease/quota`
(ADR-0093, F-027-cx), and, since F-027-db, the planner as the only writer of
a config's ceiling. Read it before the planner reads or writes a column, or
before adding one for it. The planner's rules are its own `SPEC.md` (Persian,
reference only, C-01); this file is only where its state lives.

**Why it exists.** ADR-0093 rule 4: `quotaengine/schema.sql` is not adopted.
Its tables would be a second copy of panels, configs and Grants, and two
copies of one quota disagree at the worst moment — the endgame of a bag. So
each of its concepts maps onto a row we already have, and only what the
planner *learns* gets a column. That state takes minutes of polls to learn; a
planner that loses it on a deploy boots blind and overshoots while it relearns.

## The mapping

| quotaengine | here | written by |
|---|---|---|
| `subscriptions` (`quota.Account`) | `entitlement.grant` | billing |
| `quota_bytes` (Quota) | `entitlement.grant.purchasedBytes`, read directly on every pass (ADR-0094); on a metered Grant plus its share of the reserve, `ReserveShare(meteredRate, wallet.cachedBalance, n)` (rule 20) | billing, never copied |
| `used_bytes` (Used) | Σ `lifetimeUp+DownBytes` of `config_counter_state` over every config of the Grant, retired ones included (ADR-0094) | the collector, never copied |
| `panels` | `network.panel` | — |
| `job_interval_ms` | `tickPeriodMs`, the `J` its phase mask is cut from; null = the family's interval | planner |
| `lag_mean_s`, `lag_var`, `lag_n` | `lagMeanSec`, `lagVarianceSec2`, `lagSamples` | planner |
| `reliability` | `outageWeight` at `outageWeightAt`, read as 1/(1+weight) (rule 27) | planner |
| `owner_node`, `credentials`, `base_url` | not needed / `panelApiCredentials` / `apiBaseUrl` | — |
| `replicas` (`quota.Replica`) | `network.config` | — |
| `counter` | `config_counter_state` | collector |
| `limit_seen` | `appliedCeilingBytes` | collector |
| `limit_want` | `allocatedCeilingBytes`, in lifetime bytes (rule 16) | planner (F-027-db) |
| `limit_peak` | `limitPeakBytes`, in lifetime bytes | planner |
| `writePending` (private in Go) | `writePending` | planner |
| `rate_fast`, `rate_slow` | `rateFastBps`, `rateSlowBps` | planner |
| `last_write_at` | `ceilingAppliedAt` | ceiling pass |
| `inbounds`, `groups`, `group_inbounds` | `panel_inbound`, `panel_group`, `panel_group_member` | — |
| `usage_hourly`, `outbox` | `traffic_raw_log` + rollup; the RabbitMQ events | — |

The tick phase is `tickPhaseMask`: the 32 feasible bins of `quota.TickClock`,
stored unsigned in a `BIGINT`. Null means no observation yet, which is
`TickClock.init == false`.

## The rules

1. **Quota and Used are read, never stored on a config or panel.** A column
   holding either is a copy; the planner is built from billing's figure and
   the collector's counters each pass (F-027-cy).
2. **Nothing but the planner writes these columns**, nor, since F-027-db,
   `allocatedCeilingBytes` and `walletBackedCeilingBytes` (ADR-0093 rules
   1–2). The shutdown extension reads the lag for its guard band (rule 12).
3. **Constraints hold the shapes the Go types assume**:
   `panel_tick_phase_needs_period` (a mask needs a period > 0, and fits 32
   bits), `panel_lag_matches_samples` (a mean and a variance exist exactly
   when `lagSamples > 0`, neither negative) and
   `config_lease_state_not_negative`.
4. **A column the planner needs and this table lacks is added here first**,
   with its row in the mapping. Not in a side table and not in Redis: the
   state has to survive a restart, and one place to read it is the point.

## The planner in a turn (F-027-cy, F-027-db)

`internal/leaseplan.Planner` is `collect.Loop.Planner`. It holds no driver:
it writes rows, and the convergence step carries them (rule 18).

5. **Only the Grants this turn read are planned**, and the Grants of a config
   on this panel with no ceiling yet. `PostgresStore` loads each of them
   whole, with every config and its panel. A Grant is planned while it is
   `active` or `pending` — a group's Grant activates on what its panels
   confirm, so its configs need a ceiling first — and only if it sold a limit
   (`trafficUnlimited`). A config is a replica while it can carry traffic:
   `status = active`, `desiredEnabled`, `desiredRemote = present`, the split's
   own rule (`contract.ceiling.md` "Who is in the split").
6. **Each turn: tick, then ledger, then plan** (SPEC §4). The planner's
   Observation takes Counter from the reading (up + down, or the running sum
   on a `reset_on_read` panel), Limit from `appliedCeilingBytes` less the
   offset (rule 16), and Enabled from `desiredEnabled` with no
   `lease_close` row (rule 24), because the bulk read carries no enable flag.
   `CanSetLimit` means the panel is `cumulative` and answers yes to
   `per_client_data_limit`. `Healthy` means `panelState = healthy`. J is the
   row's `tickPeriodMs`, or the family's (`leaseplan.JobInterval`) when null.
7. **The want side is the planner's own.** A replica keeps its want, its
   peak and its write in flight in memory from turn to turn; only the seen
   side is refreshed from the row. A replica first seen by a process is
   restored from its row (rule 17).
8. **Output is two log lines, `lease shadow plan`** — the names the report
   reads (rule 13), kept since the cutover — (per Grant: quota, used,
   avail, endgame, closed, and `replicas`: per config `counter`, `seen` +
   `seen_enabled` as enforced, `want` + `want_enabled` as the planner would
   writes, `allocated` as the row held it before the plan) **and `lease
   shadow action`** (per action: config, limit, enable, priority, reason,
   `allocated`). A failure is logged and never fails the turn; a lease that
   could not be written drops its replica, so the next turn restores it from
   the row it actually has.
9. **A replica's rates live in memory**, re-seeded from the counters on a
   restart: the fast rate forgets in 30 s, so a stored one is stale by the
   time it is read. `rate*` stay unwritten; the panel's state is kept (below).

## What a restart keeps (F-027-cz)

10. **A panel first seen by a process starts from its row** (`Shadow.panel`):
    J from `tickPeriodMs`, the clock from `tickPhaseMask`
    (`quota.RestoreTickClock`), the lag's mean, variance and N from `lag*`.
    Null is the family's J, a clock that has observed nothing, and
    `quota.NewLag(J)`'s initial 0.75·J.
11. **The row is written when the state moves, not every turn.** After a
    turn's plan the panel just read is compared with what its row holds
    (`Learned.Equal`); only a difference is saved, by one `UPDATE … IS
    DISTINCT FROM`. The lag is null with no sample (CHECK
    `panel_lag_matches_samples`). A failed save is logged and fails nothing
    (rule 8); the next moved state tries again.
12. **The guard band reads the same lag** (`collect.Panel.EnforcementLag`,
    `contract.ceiling.md`): with `lagSamples > 0` it is the planner's reserve
    (mean + LagZ·σ, no floor, the 10 min ceiling), so the band and the
    planner budget the same seconds; with none it is the family's 35 s,
    never the planner's 0.75·J, which is a guess and would under-cover.

## The shadow report (F-027-da)

`go run ./cmd/shadowreport < log` (`leaseplan.ReadReport`) reads only the
`lease shadow plan` lines and prints one row per Grant. It was the gate for
F-027-db (ADR-0093 rule 3); since the cutover it reads the live planner, so
overshoot and false cuts are the planner's own, and `allocated` is the figure
the row held before each plan.

13. **Overshoot is the live figure**: Used past Quota at the last plan. Only
    the live ceilings are enforced, so the planner's side is what it
    *commits*: Used plus every enabled config's room under its ceiling
    (`want` for the planner, `seen` live), the most either side ever
    committed past Quota. A ceiling of 0 bounds nothing and adds no room.
14. **A false cut is config-seconds with bytes left**: a config disabled or
    at its ceiling while Used < Quota, counted from its plan to the Grant's
    next one. A gap over `MaxTurnGap` (10 min) counts nothing — the service
    was down, not the cut long.
15. **Divergence is Σ|want − allocated| of one plan, over Quota**, and only
    while bytes are left: past the bag the planner's close (rule 24)
    against a split nobody moves any more is noise.

## The writer (F-027-db)

16. **The row counts in lifetime bytes; the planner counts on the panel's
    counter.** `Offset = max(0, lifetime served − Counter)` — what the
    convergence pass subtracts (`contract.ceiling.md`) — so a planner figure
    plus Offset is the row's, and `appliedCeilingBytes` less Offset is the
    planner's `LimitSeen`. A figure passed through both is unchanged.
17. **An action moves the allocation; every confirmation moves the peak.**
    An action writes `allocatedCeilingBytes`, and `walletBackedCeilingBytes`
    equal to it: since F-027-dc the reserve is part of Quota, so the share
    already holds what the wallet backs (CHECK
    `config_wallet_backed_ceiling_extends` holds it at least the share).
    `limitPeakBytes` and `writePending` follow the ledger on every turn. A
    replica with no ceiling and no action writes nothing. One ordered UPDATE
    per turn (invariant 54). A restarted process restores a replica's want
    from its allocation, its peak from `limitPeakBytes` (never under what
    the panel shows) and `writePending`, so a shrink written before a deploy
    frees nothing until the panel confirms it.
18. **The planner runs before the convergence step**, after the publish and
    the cursor move, so what it writes reaches the panel in the same turn. A
    woken turn reads no usage: it calls `Allocate`, which plans only the
    Grants of configs on that panel with no ceiling — no tick, no counter —
    so a new config is given its first share and created in one turn.
19. **The ceiling pass writes the planner's figure as it is, shrinks first.**
    The planner's invariant already holds rate × Lag, so no guard band comes
    off it (the band stays on the shutdown extension only), and a panel
    enforcing exactly the want is what lets a write read as landed. Shrinks
    go before grows: a shrunk share is freed only on confirmation, so a
    shrink queued behind a grow holds the next grow back a turn.

## A metered Grant (F-027-dc, ADR-0093 amendment 2026-09-27)

The planner sees the counter, so it says when a block is due; billing keeps
the money, so it decides whether one is bought (`billing/contract.traffic-block.md`
"Who asks for a block"). The hot loop's guess from the delta stream is gone.

20. **Quota is the bag plus the reserve.** On a Grant with `billingMode =
    metered` and a `meteredRate`, `PostgresStore` adds what the owner's
    `billing.wallet.cachedBalance` still buys, split evenly over the owner's
    `n` metered Grants (`leaseplan.ReserveShare`, F-027-dt, whole cents over
    the rate per 2^30 — never a float, C-02). No wallet row is a reserve of 0.
    `Purchased` keeps the bag alone. ADR-0094's amendment lists the columns. The figures are held to
    billing's by `contracts/network/block-request.json`.
21. **A block is due when the bag runs out inside the horizon**:
    `(Purchased − Used) / ΣRate.Now < Params.Horizon`, a spent bag at any
    speed. The target is `ΣRate.Demand × Horizon − (Purchased − Used)`, so an
    overrun served from the reserve is bought with it. No rate and bytes left
    is not due; no rate past the bag asks for the overrun alone. A closed
    account asks for nothing.
22. **One bag is asked for once per `BlockRetry` (30 s).** The request names
    `purchasedBytes`; billing buys only while the Grant holds it, so a second
    request for the same bag is dropped there. A request is remembered only
    once it has left: a failed publish is sent on the next turn, logged,
    failing nothing (rule 8).
23. **It rides the broker, not a call** (`network.lease.block_request`,
    `publish.BlockRequests`): a planner turn never waits on billing. Its own
    prefix, because metering dead-letters any other key under
    `network.usage.#`.

One wallet is one reserve (F-027-dt): an owner's metered Grants share it, so
two drawing at once cannot lease past the balance (`contract.reserve.md`
rule 5).

## Close by disable (F-027-dd, SPEC §6-2)

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
    closed Grant. `desiredEnabled` stays billing's — a suspension, the user's
    own switch and a revive never meet the planner's close (user, 2026-09-27).
25. **Only a renewal reopens it**: Quota or the end moved since the close,
    and `avail ≥ ReopenMin` (8 MB). A process restarted onto a closed Grant
    restores the close from the row (`Account.RestoreClosed`), so forgetting
    is never a reopen; a close row that cannot be written drops the account,
    and the next turn restores it from what was written. A disabled client
    on 3x-ui is `RemoveUser`'d, which keeps its open connections unless the
    panel restarts Xray on disable (F-027-cm, open-questions 2026-09-26).

## The poll schedule (F-027-de, SPEC §6-6)

26. **The planner says when a panel is read next.** Each plan's `PollBy`
    hints are kept per panel, the earliest since that panel's last read;
    `NextPoll` aligns it to `PollGuard` after the tick, floors it at
    `max(MinPoll, PollGap)` after the read, and every `ProbeEvery` puts one
    poll mid-tick. Memory only: a restart has no hint, and the bulk pass reads
    the panel until a plan gives one. `collect.Poller` runs it; the rules are
    `contract.hot-loop.md` "The collector's half".

## Reliability (F-027-dh, SPEC weakness #21)

27. **A panel's outage history scales its MaxLease.** The collector tells
    the planner of every failed read but our own shutdown (`Planner.Failed`);
    the first since the panel answered starts an outage, the next answer ends
    it and adds its length in `OutageUnit` (5 min), at most 1, to a count
    that halves every `OutageHalfLife` (24 h). The cap is MaxLease/(1+count),
    never under `MinLease`. Only an outage writes the row (rule 11). The start
    is memory only: a restart mid-outage forgets it, uncounted.
