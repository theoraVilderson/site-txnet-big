---
id: network
layer: domain
status: draft
version: 1
updated: 2026-09-27
---

# The lease planner on the monitoring stack (F-027-dm, SPEC §10)

What the planner exposes to Prometheus, and from where. Read it before adding
a planner number to a dashboard or an alert, or before renaming a series.
`SPEC.md` §10 lists what should be watched; this file is what exists.

## Two sources, decided by where the number lives (user, 2026-09-27)

A number the planner already keeps on a row is read by **postgres-exporter**,
through a `SECURITY DEFINER` function, as `network.collection_watchdog()` is
(`contract.resilience.md`). It keeps answering while network-service is down,
which is when it matters. A number that exists only in the process — one per
planned write — is a counter on **network-service's `/metrics`**: a row per
write would grow with the fleet to count what memory counts for nothing.

| series | source | labels | what it is |
|---|---|---|---|
| `network_planner_writes_total` | `/metrics` | `panel`, `reason` | every `Action` a plan emits, counted when planned; `reason` is `quota.Action.Reason` |
| `network_planner_false_cut_seconds_total` | `/metrics` | `panel` | config-seconds a config was cut while its Grant was open with bytes left (rule 2) |
| `network_planner_panel_lag_mean_seconds`, `…_lag_stddev_seconds`, `…_lag_samples` | `network.planner_panels()` | `panel`, `family` | the learned lag (`lagMeanSec`, √`lagVarianceSec2`); -1 before the first sample |
| `network_planner_panel_tick_known` | `network.planner_panels()` | `panel`, `family` | 1 once the tick phase is pinned (rule 3) |
| `network_planner_overshoot_ratio_p50`, `…_p95`, `…_max`, `…_closed_grants` | `network.planner_overshoot()` | `family` | overshoot per closed Grant (rule 4) |

`family` is the panel's `driverType`. No series carries a tenant, a user or a
Grant id: the exporter's role reads through the functions only, and a Grant
label would be one series per sale.

## The rules

1. **`/metrics` is private.** Served on the port `/health` uses, with no
   Traefik label (ADR-0071). Scraped by the `network-service` job in
   `dev-docker/monitoring/config-dev/prometheus.yml`. A restart zeroes both
   counters; read them through `rate()`/`increase()`, which treat that as a
   reset.
2. **A false cut is judged as the shadow report judged the live side**
   (`leaseplan.cut`, "The shadow report" in `contract.lease.md`). A config
   is cut when it is disabled or its counter is at the ceiling its panel
   enforces (`appliedCeilingBytes`). A cut counts only while the Grant is
   neither closed nor spent (`Used < Quota`). It is charged from one plan of
   the Grant to the next, to the panel of each config the earlier plan found
   cut. A gap longer than `MaxTurnGap` (10 min) is the service down or the
   Grant idle, and counts nothing. It is config-seconds, the live stand-in for
   SPEC's device-seconds: a panel shows no devices, only the config they share.
3. **`tick_known` mirrors `quota.TickClock.Known`.** A saved
   `tickPhaseMask` that is non-zero with at most 8 of its 32 bins set. Change
   `tickBins` or the quarter in Go, and the function changes with it.
4. **Overshoot is signed and settled.** It is (served − `lease_close.quotaBytes`)
   / `quotaBytes`, per Grant closed between 5 minutes and 7 days ago. Served is
   the sum of every config's lifetime counter, as the planner's read sums it.
   The 5 minutes let the last tick land. Below zero, the close left bytes
   behind. A Grant on two families is `mixed`. A renewal deletes the close
   (F-027-dd), so a renewed Grant leaves the window.
5. **Not built:** a Grafana dashboard (no dashboard is provisioned from the
   repo), alert rules on these series (no threshold has been chosen), and
   §10's 429 rate, breaker state and anomaly/drift counts. Those are
   `driver.Pacer`'s and the drift ledger's, and none is exposed yet.

## Code

`network-service/internal/leaseplan/metrics.go` (the counters, `Planner.record`),
`internal/httpapi/health.go` (`Metrics`), `cmd/server/main.go` (wiring);
migration `20260927000600_the_planner_is_watched` (both functions);
`dev-docker/monitoring/config-dev/postgres-queries.yaml`
(`network_planner_panel`, `network_planner_overshoot`).
