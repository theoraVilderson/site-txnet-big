---
id: network
layer: domain
status: draft
version: 1
keywords: [vpn, panel, xray, config, subscription link, traffic, ip access]
source: []
owns_tables: [node, config, config_action_log, traffic_raw_log, traffic_daily_aggregate, ip_access_rule]
depends_on: [identity, catalog, tenant, billing]
updated: 2026-09-04
---

# Network

**Responsibility (one sentence):** the VPN/proxy plane — Nodes running
x-ui/Xray panels, per-user Configs on those nodes, raw + daily-aggregated
traffic accounting, and durable IP access rules.
**Explicitly NOT responsible for:** charging for traffic (`billing` sub-account),
real-time rate limiting (Redis, deliberately no table), plan definitions
(`catalog`).

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

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
