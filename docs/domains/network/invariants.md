---
id: network
layer: domain
status: draft
updated: 2026-09-04
---

# Invariants — network

**DRAFT** — from schema comments; not enforced in code.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `config.uuid` is unique across the whole system (it is the Xray identity) | schema `@unique` | cross-user traffic attribution, credential clash |
| 2 | `traffic_raw_log` is only ever appended and dropped by partition — never `DELETE`d row-wise | planned partitioning ("section 99") | vacuum bloat, lost accounting |
| 3 | Daily aggregate is computed before its source raw partition is dropped | planned cron ordering | permanent traffic-data loss |
| 4 | `regenerateUsedCount` never exceeds `maxRegenerateCount` | planned service check | abuse of free re-issue |
| 5 | `panelApiCredentials` (encrypted) never default-selected or logged | planned `select`/`omit` | node panel takeover |
| 6 | Every `config` has a non-null `tenantId` (denormalized, must match the owner user's tenant) | schema NOT NULL + planned service check | cross-tenant config listing |
| 7 | A node in `maintenance` / `down` status receives no new configs | planned provisioning check | provisioning onto a dead node |

## How to test

To be written with the service. Minimum: partition-then-drop ordering test;
regenerate cap test.
