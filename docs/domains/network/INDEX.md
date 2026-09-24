---
id: network
layer: domain
status: draft
version: 15
keywords: [marzban, marzban driver, real driver, driver family, panel registration, register a panel, connection test, pending panel, refused panel, review state, connection test fault, anti-flap, contested, repair count, drift repair, mass reset, backup restore, panel drift event, collection halted, acknowledge drift event, drift, drift verdict, sync verdict, renamed client, rebuilt client, missing client, orphan, orphan client, claim tag, three-key match, limit overridden, provisioning, provision config, create config, regenerate config, enable config, disable config, move config, delete config, retire, retired config, desired state, desired remote, desired enabled, enforcement state, config actions, ceiling, ceiling allocator, ceiling convergence, convergence loop, applied ceiling, allocated ceiling, data limit, share, sub-account cap, vpn, panel, xray, config, subscription link, traffic, ip access, driver, metering, counter semantics, radius, network-service, collector, boot assertion, acceptance questionnaire, capabilities, panel registration, fake panel, conformance suite, driver fault, rate limited, 429, 403, request volume, request budget, single-flight, pacing, throttled or blocked, panel state, blocked panel, banned, cool-off, retry-after, hot loop, hot pass, time to ceiling, horizon, block floor, self-tuning interval, observed rate, collection loop, normaliser, delta, plausibility cap, quarantine, unattributed usage, nightly rollup, daily aggregate, retention, drop partition, graceful shutdown, deploy, extend ceiling, wallet-backed ceiling, watchdog, last successful collection, collector stalled, metering unavailable, collection health]
source: [txnet-backend/prisma/domains/network.prisma, txnet-backend/prisma/domains/migrations/20260921000100_panel_declares_its_driver/**, txnet-backend/prisma/domains/migrations/20260921000200_config_carries_its_desired_state/**, txnet-backend/prisma/domains/migrations/20260921000300_usage_is_billed_held_or_quarantined/**, txnet-backend/prisma/domains/migrations/20260921000400_a_radius_session_is_closed_not_abandoned/**, txnet-backend/prisma/domains/migrations/20260921000500_traffic_is_partitioned_by_month/**, txnet-backend/prisma/domains/migrations/20260921000900_the_rollup_commits_before_the_partition_drops/**, txnet-backend/prisma/domains/migrations/20260922000300_a_ceiling_the_wallet_still_backs/**, txnet-backend/prisma/domains/migrations/20260922000400_the_watchdog_sees_every_panel/**, txnet-backend/prisma/domains/migrations/20260923000100_a_retired_config_never_comes_back/**, txnet-backend/prisma/domains/migrations/20260923000200_every_config_carries_its_claim_tag/**, txnet-backend/prisma/domains/migrations/20260923000300_a_repair_is_counted_in_a_window/**, txnet-backend/prisma/domains/migrations/20260923000400_a_panel_that_did_not_answer_says_why/**, txnet-backend/shared-core/src/lib/prisma/network-panel-declaration.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-config-desired-state.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-usage-accounting.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-radius-session.spec.ts, txnet-backend/shared-core/src/lib/prisma/network-traffic-partitioning.spec.ts, network-service/**, contracts/network/capabilities.json, contracts/network/delta.json, txnet-backend/shared-core/src/lib/automation/usage-delta.ts, txnet-backend/billing-service/src/app/traffic/ceiling-allocator.ts, txnet-backend/billing-service/src/app/traffic/ceiling-allocator.spec.ts, txnet-backend/billing-service/src/app/traffic/horizon.ts, txnet-backend/billing-service/src/app/traffic/horizon.spec.ts, txnet-backend/billing-service/src/app/traffic/collection-health.ts, txnet-backend/billing-service/src/app/traffic/collection-health.controller.ts, txnet-backend/billing-service/src/app/traffic/collection-health.spec.ts, dev-docker/monitoring/config-dev/network.rules.yml, txnet-backend/billing-service/src/app/traffic/config-actions.ts, txnet-backend/billing-service/src/app/traffic/config-actions.spec.ts]
owns_tables: [panel, config, config_action_log, traffic_raw_log, traffic_daily_aggregate, ip_access_rule, config_counter_state, usage_delta_seen, usage_delta_quarantine, usage_hold, panel_drift_event, unattributed_usage, radius_session]
depends_on: [identity, entitlement, tenant, billing]
updated: 2026-09-24
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
| [contract.provisioning.md](contract.provisioning.md) | creating, regenerating, enabling, disabling, moving or deleting a config: the desired-state writers and the one pass that carries them |
| [contract.drift.md](contract.drift.md) | a client was renamed, rebuilt or deleted on the panel, or matches no config: the three-key match and the drift verdicts |
| [contract.budget.md](contract.budget.md) | how often a panel may be asked, what a `429`/`403` means, and the rate a pass writes back |
| [contract.hot-loop.md](contract.hot-loop.md) | a config near its ceiling is read sooner than the bulk pass reads it, and the next block is sized in seconds |
| [contract.rollup.md](contract.rollup.md) | the nightly aggregate, retention, and dropping a raw partition |
| [contract.drivers.md](contract.drivers.md) | a real panel family's driver (Marzban, …): what its API maps to, and the family's rules |
| [contract.registration.md](contract.registration.md) | a panel is registered: the connection test, its verdict or its fault, and why only an accepted panel is collected |
| [contract.resilience.md](contract.resilience.md) | the collector is stopping or has stopped: the shutdown extension, the watchdog, and what the user is told |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-23 | A deploy cuts nobody off: on exit every ceiling is raised to what the wallet backs (`walletBackedCeilingBytes`, ADR-0078); a watchdog outside the process reads `lastSuccessfulCollectionAt`; `GET /api/billing/traffic/collection-health` tells the user (contract v11, F-027-w) |
| 2026-09-23 | Every config action is a desired-state write (`ConfigActionsService`) and `converge.Provisioning` is the only caller of a panel's client lifecycle; `ConfigStatus.retired` for delete and the old side of a move, which a top-up never revives (contract v12, F-027-z) |
| 2026-09-23 | A client is found by `remoteId` → `claimTag` → `uuid`; renamed/rebuilt clients are re-keyed, never recreated, and every pass writes a drift verdict. `claimTag` NOT NULL (contract v13, F-027-aa) |
| 2026-09-23 | Drift containment: a missing client is recreated as a repair, two repairs within 24 h and the next is held `contested` (`driftRepairedAt`), a ceiling above ours is always rewritten; >20% (and ≥5) counters going backward in one pass quarantines them and halts the panel's collection until acknowledged (contract v14, F-027-ab) |
| 2026-09-23 | Registration is desired state (ADR-0080): `register.Registrar` tests `pending` panels, writes a verdict only from validated answers, else leaves them `pending` with `connectionTestFault`; `collect.Loop` reads only accepted panels (contract v15, F-027-aq) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
