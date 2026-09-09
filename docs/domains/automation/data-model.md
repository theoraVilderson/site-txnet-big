---
id: automation
layer: domain
status: draft
updated: 2026-09-09
---

# Data model — automation

Source of truth: `txnet-backend/prisma/domains/automation.prisma` (Postgres schema
`automation`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| bot_worker | worker definition + category + `isActive` master switch | no | permanent |
| bot_schedule | when a worker runs (window / cron / always), timezone, admin-set | no | permanent |
| bot_execution_log | per-run: trigger source, timing, status, items processed, errors, metrics JSON | no | long / rolling |
| bot_integration | one bot a tenant owns: platform, `@username`, `role`, `credentialRef`, `webhookPath`, `status` + `lastErrorAt`, cached `capabilities` | yes — but see below | with tenant |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| bot_execution_log (referenced) | -> | notification.notification_campaign.executedByBotWorkerId, ai.ai_recommendation.generatedByBotWorkerId | other domains record which worker acted |
| bot_integration.tenantId | -> | tenant.tenant.id | **no foreign key** — the pattern every schema outside `tenant` uses for a `tenantId` |
| bot_integration.credentialRef | -> | tenant.tenant_credential.label | not a foreign key either: the vault is reached through `tenant`'s contract, never by joining to its tables (§8) |

## Access rules

Draft. No service yet; when built, no unit outside `automation` writes these
tables and reads go through a `automation` service API.

`bot_integration` is tenant-scoped data that is **not** registered with the
`withTenant` extension, and the exception is deliberate: a webhook is looked up
by its path in order to discover which tenant it belongs to, so there is no
ambient tenant to scope the query by yet. The same reasoning the vault tables
document (`domains/tenant/contract.vault.md`). What confines a row is the
`credentialRef` it carries: the value behind it is sealed under that tenant's
own DEK, so a query that escaped its tenant still gets nothing usable.

## Migration notes

`20260909000200_bot_integration` creates `bot_integration` and drops
`tenant.tenant_bot_integration`. Destructive and safe to be: the old table was
never written and no code ever read it, so nothing was migrated.

It carries its own **section 99** SQL — the partial unique index
`bot_integration_one_primary_per_tenant_platform`, which Prisma cannot express
and invariant #5 is. Row-Level Security and the remaining partitioning work
noted in the schema are still **not applied**.
