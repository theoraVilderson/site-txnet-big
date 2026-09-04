---
id: network
layer: domain
updated: 2026-09-04
---

# Data model — network

Source of truth: `txnet-backend/prisma/domains/network.prisma` (Postgres schema
`network`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| node | server running x-ui/Xray; HA pair; region; status | `tenantId` nullable | permanent |
| config | user credential on a node (uuid + protocol + status) | `tenantId` NOT NULL (denormalized) | soft state via `status` |
| config_action_log | who did what to a config | via config | permanent |
| traffic_raw_log | per-interval up/down bytes; **monthly partitioned**, BigInt PK | via config | drop old partitions |
| traffic_daily_aggregate | nightly rollup per (user, config, date) | via config | long |
| ip_access_rule | durable block / allow / custom-rate-limit by IP or CIDR | no | expires if `expiresAt` set |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| config.userId | -> | identity.user.id | a config belongs to a user |
| config.servicePlanId | -> | catalog.service_plan.id | the plan it was bought under |
| config.tenantId, node.tenantId | -> | tenant.tenant.id | dedicated pools / reseller panels |
| config (referenced) | <- | billing.sub_account.configId | sub-account funds a config |

## Access rules

Reseller panels read `config` filtered by `tenantId` (composite index leads with
`tenantId`). Traffic tables are written by an ingestion path, read by reporting.

## Migration notes

Native monthly partitioning on `traffic_raw_log` (and BRIN index on
`recordedAt`), plus RLS, are "section 99" manual SQL — **not applied**. Prisma
cannot express partitioning; the model must be created by hand-written migration.
