---
id: automation
layer: domain
status: active
version: 8
keywords: [automation, worker, scheduler, cron, background job, bot integration, tenant bot, webhook path, bot role, provision a bot, seed a bot, ربات ثبت نمیشه, روبات ها کار نمیکنن, outbox, outbox event, transactional outbox, relay]
source:
  - txnet-backend/auth-service/src/app/automation/**
  - txnet-backend/auth-service/src/seed-bot-integration.ts
  - txnet-backend/worker-service/src/app/**
  - txnet-backend/shared-core/src/lib/automation/**
  - txnet-backend/prisma/domains/automation.prisma
owns_tables: [bot_worker, bot_schedule, bot_execution_log, bot_integration, dead_letter, outbox_event]
depends_on: [tenant, bot-app]
updated: 2026-09-20
---

# Automation

**Responsibility (one sentence):** the registry, scheduling and run-history of background workers (campaign senders, fraud scanners, aggregators, reconcilers, metering).
**Also owns:** the registry of bots a tenant runs (`bot_integration`) — which bot, on which platform, at which webhook path, in which role.
**Built so far:** `bot_integration`, the worker *runtime* — `worker-service`
registers each job as a `bot_worker`, publishes a tick per due schedule and
appends a `bot_execution_log` per run — the admin surface that writes them,
five `/auth/workers` routes in `auth-service` (F-031-b), the first job that
does real work (`vault_credential_retention`, F-031-c), and since F-067-a a
second queue this process consumes without a schedule: OTP delivery. Since
F-067-c the outbox ADR-0021 decided exists too — the table and its relay job.
**Explicitly NOT responsible for:** the business logic each worker performs (that lives in the domain the worker serves), and any bot's credentials (the Credential Vault in `tenant` holds those).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing automation from outside |
| [contract.worker.md](contract.worker.md) | the worker runtime, the queues, the jobs |
| [contract.tenant-cap.md](contract.tenant-cap.md) | one tenant is taking every run slot (catalog 20.2 layer 4) |
| [contract.outbox.md](contract.outbox.md) | announcing a cross-domain event, or consuming one (ADR-0021) |
| [contract.notices.md](contract.notices.md) | how an event tells a person — live, inbox, bot, and a burst combined (ADR-0084) |
| [contract.admin.md](contract.admin.md) | the five `/auth/workers` routes |
| [contract.bots.md](contract.bots.md) | a reseller connects, lists or retires a bot |
| [contract.monitoring.md](contract.monitoring.md) | an alert fired, or a threshold needs moving |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-20 | v7 -> **v8**: a reseller's bots can be connected and retired — `/api/auth/tenants/:tenantId/bots`, the token proved with the messenger and kept in the vault, the webhook registered and withdrawn (F-066-w5, ADR-0064). See [contract.bots.md](contract.bots.md) |
| 2026-09-17 | v6 -> **v7** (**break**): the `tenant.campaigns.stop_requested` event, `TenantCampaignStopConsumer` and its queue are gone — the platform owner stops a reseller's campaigns by calling notification-service (F-018-w, ADR-0058 (5)) |
| 2026-09-10 | F-069: `seed-bot-integration` provisions a `bot_integration` and its two vault credentials, so a deployment can put a bot back after a `migrate reset` empties the table. Additive — no version bump; nothing that reads the table changed shape. It is a **dev provisioning path**, and F-018 is what replaces it |
| 2026-09-10 | `version` 5 -> 6: a rejected message is dead-lettered and recorded instead of destroyed — invariant #9, the `dead_letter` table, `GET /admin/workers/dead-letters` (F-067-d) |
| 2026-09-09 | `version` 4 -> 5: an admin can write what the runtime reads — `/admin/workers` in `auth-service`, invariant #2 enforced at write time, `admin_manual` runs (F-031-b) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
