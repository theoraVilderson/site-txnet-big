---
id: automation
layer: domain
status: draft
updated: 2026-09-10
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
| outbox_event | one cross-domain event, written inside the transaction that caused it and published by `OutboxRelayJob` (F-067-c, ADR-0021) | no — see below | permanent (no archive yet) |
| dead_letter | one message the queue could not deliver: routing key, worker key, `reason` (`handler_failed` / `unparseable` / `gate_gave_up`), attempts, the body, and when it died (F-067-d) | no — see below | long / rolling |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| bot_execution_log (referenced) | -> | notification.notification_campaign.executedByBotWorkerId, ai.ai_recommendation.generatedByBotWorkerId | other domains record which worker acted |
| bot_integration.tenantId | -> | tenant.tenant.id | **no foreign key** — the pattern every schema outside `tenant` uses for a `tenantId` |
| bot_integration.credentialRef | -> | tenant.tenant_credential.label | not a foreign key either: the vault is reached through `tenant`'s contract, never by joining to its tables (§8) |

## Access rules

Draft. No service yet; when built, no unit outside `automation` writes these
tables and reads go through a `automation` service API.

`dead_letter` carries **no `tenantId`**, like the three worker tables: a worker
is a platform-wide process, and a tick's tenant — when it has one — is inside
`payload`. That is why it takes no RLS policy:
`20260909001500_row_level_security_all_tables` policies every table *with* a
`tenantId`, so a table without one is simply readable by the roles already
granted the schema. Only `worker-service` writes it, draining the dead-letter
queue; only `auth-service` reads it, at `GET /admin/workers/dead-letters`.

`outbox_event` carries **no `tenantId`** for the same reason `dead_letter`
does not, plus one of its own: the relay is a platform-wide process that must
read every tenant's events, so the column would need an RLS policy shape
chosen for a table whose only reader is unscoped. Which tenant an event
concerns lives in `payload`, where the domain that wrote it decides what its
own event means. Only `worker-service` reads and stamps it; a producing domain
only ever inserts, inside its own transaction.

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

`20260910000000_automation_dead_letter` adds `dead_letter` and its enum
(F-067-d). Additive, no backfill, and no policy — see the access note above and
the migration's own header.

`20260909000200_bot_integration` also carries **section 99** SQL — the partial
unique index `bot_integration_one_primary_per_tenant_platform`, which Prisma
cannot express and invariant #5 is. Row-Level Security and the remaining
partitioning work noted in the schema are still **not applied**.

`20260910001000_automation_outbox` adds `outbox_event` (F-067-c). Additive, no
backfill, no policy. It carries its own **section 99** SQL: the partial index
`outbox_event_unpublished_idx` (`WHERE "publishedAt" IS NULL`), which Prisma
cannot express and which is the index the relay actually uses — published rows
accumulate for ever and unpublished ones are a working set of near zero, so
the partial index stays the size of the backlog rather than of the history.
