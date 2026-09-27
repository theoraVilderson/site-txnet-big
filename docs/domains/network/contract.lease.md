---
id: network
layer: domain
status: draft
version: 2
updated: 2026-09-27
---

# The lease planner's state — what it learns, and where it keeps it

What governs the storage behind `network-service/internal/lease/quota`
(ADR-0093, F-027-cx). Read it before the planner reads or writes a column, or
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
| `quota_bytes` (Quota) | `entitlement.grant.purchasedBytes`, read directly on every pass (ADR-0094); the metered reserve is added to it in F-027-dc | billing, never copied |
| `used_bytes` (Used) | Σ `lifetimeUp+DownBytes` of `config_counter_state` over every config of the Grant, retired ones included (ADR-0094) | the collector, never copied |
| `panels` | `network.panel` | — |
| `job_interval_ms` | `tickPeriodMs`, the `J` its phase mask is cut from; null = the family's interval | planner |
| `lag_mean_s`, `lag_var`, `lag_n` | `lagMeanSec`, `lagVarianceSec2`, `lagSamples` | planner |
| `reliability` | not yet (F-027-dh) | — |
| `owner_node`, `credentials`, `base_url` | not needed / `panelApiCredentials` / `apiBaseUrl` | — |
| `replicas` (`quota.Replica`) | `network.config` | — |
| `counter` | `config_counter_state` | collector |
| `limit_seen` | `appliedCeilingBytes` | collector |
| `limit_want` | `allocatedCeilingBytes` | billing until F-027-db, then planner |
| `limit_peak` | `limitPeakBytes` | planner |
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
2. **Nothing but the planner writes these columns.** The collector reads the
   lag for the guard band (rule 12). Until F-027-db the planner writes no
   ceiling, so `limitPeakBytes` and `writePending` would describe only what
   it *would* have written; they stay unwritten until then.
3. **Constraints hold the shapes the Go types assume**:
   `panel_tick_phase_needs_period` (a mask needs a period > 0, and fits 32
   bits), `panel_lag_matches_samples` (a mean and a variance exist exactly
   when `lagSamples > 0`, neither negative) and
   `config_lease_state_not_negative`.
4. **A column the planner needs and this table lacks is added here first**,
   with its row in the mapping. Not in a side table and not in Redis: the
   state has to survive a restart, and one place to read it is the point.

## The shadow (F-027-cy)

`internal/leaseplan.Shadow` is `collect.Loop.Shadow`. It runs last in a
panel's turn, after the publish, the cursor move and the convergence step, and
it holds no driver.

5. **Only the Grants this turn read are planned.** The turn's claimed configs
   pick the Grants, and `PostgresStore` loads each of them whole, with every
   config and its panel. A Grant is left out if it is not `active` or if it
   sold no limit (`trafficUnlimited`). A config is a replica while it is not
   `retired` and `desiredRemote = present`.
6. **Each turn: tick, then ledger, then plan** (SPEC §4). The planner's
   Observation takes Counter from the reading (up + down, or the running sum
   on a `reset_on_read` panel), Limit from `appliedCeilingBytes`, and Enabled
   from `desiredEnabled`, because the bulk read carries no enable flag.
   `CanSetLimit` means the panel is `cumulative` and answers yes to
   `per_client_data_limit`. `Healthy` means `panelState = healthy`. J is the
   row's `tickPeriodMs`, or the family's (`leaseplan.JobInterval`) when null.
7. **A want the shadow logs is never in flight.** Before each turn a replica's
   want side is set to what the live writer applied, and `Plan` runs on copies
   of the replicas. Without this, one logged want would read as a write that
   never lands. The next turn would then say nothing until `DriftAfter`.
8. **Output is two log lines, `lease shadow plan`** (per Grant: quota, used,
   avail, endgame, closed) **and `lease shadow action`** (per action: config,
   limit, enable, priority, reason, and `allocated`, the live split beside
   it). F-027-da reads these lines. A shadow failure is logged and never fails
   the turn.
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
