---
id: network
layer: domain
status: draft
version: 4
keywords: [vpn, panel, xray, config, subscription link, traffic, ip access, driver, metering, counter semantics, radius, network-service, collector, boot assertion, acceptance questionnaire, capabilities, panel registration, fake panel, conformance suite, driver fault, rate limited, 429]
source: [txnet-backend/prisma/domains/network.prisma, txnet-backend/prisma/domains/migrations/20260921000100_panel_declares_its_driver/**, txnet-backend/prisma/domains/migrations/20260921000200_config_carries_its_desired_state/**, txnet-backend/prisma/domains/migrations/20260921000300_usage_is_billed_held_or_quarantined/**, txnet-backend/prisma/domains/migrations/20260921000400_a_radius_session_is_closed_not_abandoned/**, txnet-backend/prisma/domains/migrations/20260921000500_traffic_is_partitioned_by_month/**, txnet-backend/shared-core/src/lib/prisma/network-panel-declaration.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-config-desired-state.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-usage-accounting.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-radius-session.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-traffic-partitioning.spec.ts, network-service/**, contracts/network/capabilities.json]
owns_tables: [panel, config, config_action_log, traffic_raw_log, traffic_daily_aggregate, ip_access_rule, config_counter_state, usage_delta_seen, usage_delta_quarantine, usage_hold, panel_drift_event, unattributed_usage, radius_session]
depends_on: [identity, entitlement, tenant, billing]
updated: 2026-09-21
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
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |
| 2026-09-06 | **Breaking:** model/table `Node` -> `Panel` (contract v2). Zero consumers |
| 2026-09-21 | **Breaking:** a Panel declares its driver, counter and transport (contract v3, F-027-a). `panelType` -> `driverType`, `status` -> `panelState`. Zero consumers |
| 2026-09-21 | **Breaking:** `Driver` gains `ListClients`, and every driver error is a `*Fault` (contract v4, F-027-j). Sole implementation is the fake |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
