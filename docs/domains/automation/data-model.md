---
id: automation
layer: domain
status: draft
updated: 2026-09-04
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

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| bot_execution_log (referenced) | -> | notification.notification_campaign.executedByBotWorkerId, ai.ai_recommendation.generatedByBotWorkerId | other domains record which worker acted |

## Access rules

Draft. No service yet; when built, no unit outside `automation` writes these
tables and reads go through a `automation` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
