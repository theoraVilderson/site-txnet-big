---
id: network
layer: domain
status: draft
updated: 2026-09-21
---

# Invariants — network

**DRAFT** — 1-7 are from schema comments and not enforced in code. 8-12 are
enforced by the database as of F-027-a, 13-17 as of F-027-b.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `config.uuid` is unique across the whole system (it is the Xray identity) | schema `@unique` | cross-user traffic attribution, credential clash |
| 2 | `traffic_raw_log` is only ever appended and dropped by partition — never `DELETE`d row-wise | planned partitioning ("section 99") | vacuum bloat, lost accounting |
| 3 | Daily aggregate is computed before its source raw partition is dropped | planned cron ordering | permanent traffic-data loss |
| 4 | `regenerateUsedCount` never exceeds `maxRegenerateCount` | planned service check | abuse of free re-issue |
| 5 | `panelApiCredentials` (encrypted) never default-selected or logged | planned `select`/`omit` | node panel takeover |
| 6 | Every `config` has a non-null `tenantId` (denormalized, must match the owner user's tenant) | schema NOT NULL + planned service check | cross-tenant config listing |
| 7 | A panel in `maintenance` / `down` / `throttled_or_blocked` state receives no new configs | planned provisioning check | provisioning onto a dead node |
| 8 | Every Panel declares `driverType`, `counterSemantics` and `transport` | schema NOT NULL, no default (F-027-a) | usage counted by the wrong arithmetic — a plausible wrong number, not a crash |
| 9 | `ownershipType = tenant` exactly when `tenantId` is set | CHECK `panel_ownership_matches_tenant` | an alert routed to the wrong owner, or a tenant's cost billed to the platform |
| 10 | A `pull` panel has an `apiBaseUrl` | CHECK `panel_pull_has_base_url` | a driver guessing a base URL per family |
| 11 | `blockedSince` is set exactly while `panelState = throttled_or_blocked` | CHECK `panel_blocked_since_needs_state` | no clock on a ban, so retrying through it makes it permanent |
| 12 | `maxRequestsPerMinute` is positive | CHECK `panel_request_budget_positive` | a budget of zero stops collection on that panel silently |
| 13 | A ceiling, allocated or applied, is never negative | CHECK `config_ceiling_bytes_not_negative` | a limit written to a panel that no traffic fits under — the user is cut off holding paid bytes |
| 14 | `ceilingAppliedAt` is set exactly when `appliedCeilingBytes` is | CHECK `config_applied_ceiling_needs_time` | no clock on the write, so a stale ceiling reads as a fresh one and is never rewritten |
| 15 | A completed purge holds no `remoteId` | CHECK `config_purged_has_no_remote_id` | the loop adopts a panel seat it has just freed, and usage is attributed to a client that is gone |
| 16 | One remote client belongs to one config | UNIQUE `(panelId, remoteId)` | one client's traffic counted against two configs, or a ceiling written twice with two different numbers |
| 17 | `claimTag` is unique across the whole system | schema `@unique` | the second matching key matches the wrong row, which is invariant 1's failure reached the long way round |

## How to test

Invariants 8-17 are held by the schema and the migration history, and that
those two agree is asserted by
`shared-core/src/lib/prisma/network-panel-declaration.spec.ts` (8-12) and
`network-config-desired-state.spec.ts` (13-17) — the CI stand-in for the
boot-time column assertion ADR-0071 gives `network-service`.

The rest is to be written with the service. Minimum: partition-then-drop
ordering test; regenerate cap test.
