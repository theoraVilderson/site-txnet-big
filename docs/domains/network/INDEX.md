---
id: network
layer: domain
status: draft
version: 11
keywords: [ceiling, ceiling allocator, ceiling convergence, convergence loop, applied ceiling, allocated ceiling, data limit, share, sub-account cap, vpn, panel, xray, config, subscription link, traffic, ip access, driver, metering, counter semantics, radius, network-service, collector, boot assertion, acceptance questionnaire, capabilities, panel registration, fake panel, conformance suite, driver fault, rate limited, 429, 403, request volume, request budget, single-flight, pacing, throttled or blocked, panel state, blocked panel, banned, cool-off, retry-after, hot loop, hot pass, time to ceiling, horizon, block floor, self-tuning interval, observed rate, collection loop, normaliser, delta, plausibility cap, quarantine, unattributed usage, nightly rollup, daily aggregate, retention, drop partition, graceful shutdown, deploy, extend ceiling, wallet-backed ceiling, watchdog, last successful collection, collector stalled, metering unavailable, collection health]
source: [txnet-backend/prisma/domains/network.prisma, txnet-backend/prisma/domains/migrations/20260921000100_panel_declares_its_driver/**, txnet-backend/prisma/domains/migrations/20260921000200_config_carries_its_desired_state/**, txnet-backend/prisma/domains/migrations/20260921000300_usage_is_billed_held_or_quarantined/**, txnet-backend/prisma/domains/migrations/20260921000400_a_radius_session_is_closed_not_abandoned/**, txnet-backend/prisma/domains/migrations/20260921000500_traffic_is_partitioned_by_month/**, txnet-backend/prisma/domains/migrations/20260921000900_the_rollup_commits_before_the_partition_drops/**, txnet-backend/prisma/domains/migrations/20260922000300_a_ceiling_the_wallet_still_backs/**, txnet-backend/prisma/domains/migrations/20260922000400_the_watchdog_sees_every_panel/**, txnet-backend/shared-core/src/lib/prisma/network-panel-declaration.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-config-desired-state.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-usage-accounting.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-radius-session.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-traffic-partitioning.spec.ts, network-service/**, contracts/network/capabilities.json, contracts/network/delta.json, txnet-backend/shared-core/src/lib/automation/usage-delta.ts, txnet-backend/billing-service/src/app/traffic/ceiling-allocator.ts, txnet-backend/billing-service/src/app/traffic/ceiling-allocator.spec.ts, txnet-backend/billing-service/src/app/traffic/horizon.ts, txnet-backend/billing-service/src/app/traffic/horizon.spec.ts, txnet-backend/billing-service/src/app/traffic/collection-health.ts, txnet-backend/billing-service/src/app/traffic/collection-health.controller.ts, txnet-backend/billing-service/src/app/traffic/collection-health.spec.ts, dev-docker/monitoring/config-dev/network.rules.yml]
owns_tables: [panel, config, config_action_log, traffic_raw_log, traffic_daily_aggregate, ip_access_rule, config_counter_state, usage_delta_seen, usage_delta_quarantine, usage_hold, panel_drift_event, unattributed_usage, radius_session]
depends_on: [identity, entitlement, tenant, billing]
updated: 2026-09-23
---

# Network

**Responsibility (one sentence):** the VPN/proxy plane — Panels (server
installs running x-ui/Xray), per-user Configs on those Panels, raw +
daily-aggregated traffic accounting, and durable IP access rules.
**Explicitly NOT responsible for:** charging for traffic (`billing` sub-account),
real-time rate limiting (Redis, deliberately no table), product definitions
(`catalog`), who holds a service (`entitlement` Grant).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing network from outside |
| [contract.collection.md](contract.collection.md) | the bulk collection loop: the three delta maths, reset detection, the plausibility cap, quarantine |
| [contract.ceiling.md](contract.ceiling.md) | a Grant's purchased bytes are split across its configs, and the share is carried to the panel that enforces it |
| [contract.budget.md](contract.budget.md) | how often a panel may be asked, what a `429`/`403` means, and the rate a pass writes back |
| [contract.hot-loop.md](contract.hot-loop.md) | a config near its ceiling is read sooner than the bulk pass reads it, and the next block is sized in seconds |
| [contract.rollup.md](contract.rollup.md) | the nightly aggregate, retention, and dropping a raw partition |
| [contract.resilience.md](contract.resilience.md) | the collector is stopping or has stopped: the shutdown extension, the watchdog, and what the user is told |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-22 | A Grant's ceiling is allocated across its configs, `Σ ceilings ≤ purchasedBytes` (contract v7, F-027-s) |
| 2026-09-22 | The allocation reaches the panel: `SetClientDataLimit` from `internal/converge`, `applied` read back off the panel, and the ceiling rewritten in the pass that sees a counter reset (contract v8, F-027-t) |
| 2026-09-22 | The hot loop: the few configs near a ceiling are read on a self-tuning interval, and the next block is a horizon in seconds of the measured rate (contract v9, F-027-u) |
| 2026-09-22 | The request budget comes off the panel row, and a panel refusing us is not retried through: `429`/`403` is `throttled_or_blocked`, alerted once and left alone, where `down` is read on the next pass (contract v10, F-027-v) |
| 2026-09-23 | A deploy cuts nobody off: on exit every ceiling is raised to what the wallet backs (`walletBackedCeilingBytes`, ADR-0078); a watchdog outside the process reads `lastSuccessfulCollectionAt`; `GET /api/billing/traffic/collection-health` tells the user (contract v11, F-027-w) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
