---
id: network
layer: domain
status: draft
version: 3
keywords: [vpn, panel, xray, config, subscription link, traffic, ip access, driver, metering, counter semantics, radius]
source: [txnet-backend/prisma/domains/network.prisma, txnet-backend/prisma/domains/migrations/20260921000100_panel_declares_its_driver/**, txnet-backend/shared-core/src/lib/prisma/network-panel-declaration.spec.ts]
owns_tables: [panel, config, config_action_log, traffic_raw_log, traffic_daily_aggregate, ip_access_rule]
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

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
