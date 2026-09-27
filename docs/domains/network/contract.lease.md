---
id: network
layer: domain
status: draft
version: 1
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
| `quota_bytes` (Quota) | read from billing per pass: the Grant's bag (`purchasedBytes`; the metered reserve joins it in F-027-dc) | billing, never copied |
| `used_bytes` (Used) | `grant.consumedBytes` (what the panels reported, F-027-n) | the collector's deltas, never copied |
| `panels` | `network.panel` | — |
| `job_interval_ms` | `tickPeriodMs` (learned `J`); null = the family's interval | planner |
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
2. **Nothing reads these columns before the shadow planner** (F-027-cy), and
   nothing but the planner writes them. Until F-027-db the planner writes no
   ceiling to a panel, so `limitPeakBytes` and `writePending` describe only
   what it *would* have written.
3. **Constraints hold the shapes the Go types assume**:
   `panel_tick_phase_needs_period` (a mask needs a period > 0, and fits 32
   bits), `panel_lag_matches_samples` (a mean and a variance exist exactly
   when `lagSamples > 0`, neither negative) and
   `config_lease_state_not_negative`.
4. **A column the planner needs and this table lacks is added here first**,
   with its row in the mapping. Not in a side table and not in Redis: the
   state has to survive a restart, and one place to read it is the point.
