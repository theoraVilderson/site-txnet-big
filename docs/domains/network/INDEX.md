---
id: network
layer: domain
status: draft
version: 8
keywords: [ceiling, ceiling allocator, ceiling convergence, convergence loop, applied ceiling, allocated ceiling, data limit, share, sub-account cap, vpn, panel, xray, config, subscription link, traffic, ip access, driver, metering, counter semantics, radius, network-service, collector, boot assertion, acceptance questionnaire, capabilities, panel registration, fake panel, conformance suite, driver fault, rate limited, 429, request volume, request budget, single-flight, pacing, collection loop, normaliser, delta, plausibility cap, quarantine, unattributed usage, nightly rollup, daily aggregate, retention, drop partition]
source: [txnet-backend/prisma/domains/network.prisma, txnet-backend/prisma/domains/migrations/20260921000100_panel_declares_its_driver/**, txnet-backend/prisma/domains/migrations/20260921000200_config_carries_its_desired_state/**, txnet-backend/prisma/domains/migrations/20260921000300_usage_is_billed_held_or_quarantined/**, txnet-backend/prisma/domains/migrations/20260921000400_a_radius_session_is_closed_not_abandoned/**, txnet-backend/prisma/domains/migrations/20260921000500_traffic_is_partitioned_by_month/**, txnet-backend/prisma/domains/migrations/20260921000900_the_rollup_commits_before_the_partition_drops/**, txnet-backend/shared-core/src/lib/prisma/network-panel-declaration.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-config-desired-state.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-usage-accounting.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-radius-session.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-traffic-partitioning.spec.ts, network-service/**, contracts/network/capabilities.json, contracts/network/delta.json, txnet-backend/shared-core/src/lib/automation/usage-delta.ts, txnet-backend/billing-service/src/app/traffic/ceiling-allocator.ts, txnet-backend/billing-service/src/app/traffic/ceiling-allocator.spec.ts]
owns_tables: [panel, config, config_action_log, traffic_raw_log, traffic_daily_aggregate, ip_access_rule, config_counter_state, usage_delta_seen, usage_delta_quarantine, usage_hold, panel_drift_event, unattributed_usage, radius_session]
depends_on: [identity, entitlement, tenant, billing]
updated: 2026-09-22
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
| [contract.rollup.md](contract.rollup.md) | the nightly aggregate, retention, and dropping a raw partition |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-21 | **Breaking:** `Driver` gains `ListClients`, and every driver error is a `*Fault` (contract v4, F-027-j). Sole implementation is the fake |
| 2026-09-21 | The unit emits: one pass is one `network.usage.delta` message, declared in `contracts/network/delta.json` (contract v5, F-027-m) |
| 2026-09-21 | The nightly aggregate exists, and a raw partition is dropped only once its aggregate matches (contract v6, F-027-o) |
| 2026-09-22 | A Grant's ceiling is allocated across its configs, `Σ ceilings ≤ purchasedBytes` (contract v7, F-027-s) |
| 2026-09-22 | The allocation reaches the panel: `SetClientDataLimit` from `internal/converge`, `applied` read back off the panel, and the ceiling rewritten in the pass that sees a counter reset (contract v8, F-027-t) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
