---
id: automation
layer: domain
status: active
version: 6
keywords: [automation, worker, scheduler, cron, background job, bot integration, tenant bot, webhook path, bot role, provision a bot, seed a bot, ربات ثبت نمیشه, روبات ها کار نمیکنن, outbox, outbox event, transactional outbox, relay]
source:
  - txnet-backend/auth-service/src/app/automation/**
  - txnet-backend/auth-service/src/seed-bot-integration.ts
  - txnet-backend/worker-service/src/app/**
  - txnet-backend/shared-core/src/lib/automation/**
  - txnet-backend/prisma/domains/automation.prisma
owns_tables: [bot_worker, bot_schedule, bot_execution_log, bot_integration, dead_letter, outbox_event]
depends_on: [tenant, bot-app]
updated: 2026-09-10
---

# Automation

**Responsibility (one sentence):** the registry, scheduling and run-history of background workers (campaign senders, fraud scanners, aggregators, reconcilers, metering).
**Also owns:** the registry of bots a tenant runs (`bot_integration`) — which bot, on which platform, at which webhook path, in which role.
**Built so far:** `bot_integration`, the worker *runtime* — `worker-service`
registers each job as a `bot_worker`, publishes a tick per due schedule and
appends a `bot_execution_log` per run — the admin surface that writes them,
five `/admin/workers` routes in `auth-service` (F-031-b), the first job that
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
| [contract.admin.md](contract.admin.md) | the five `/admin/workers` routes |
| [contract.monitoring.md](contract.monitoring.md) | an alert fired, or a threshold needs moving |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-10 | F-069: `seed-bot-integration` provisions a `bot_integration` and its two vault credentials, so a deployment can put a bot back after a `migrate reset` empties the table. Additive — no version bump; nothing that reads the table changed shape. It is a **dev provisioning path**, and F-018 is what replaces it |
| 2026-09-10 | `version` 5 -> 6: a rejected message is dead-lettered and recorded instead of destroyed — invariant #9, the `dead_letter` table, `GET /admin/workers/dead-letters` (F-067-d) |
| 2026-09-09 | `version` 4 -> 5: an admin can write what the runtime reads — `/admin/workers` in `auth-service`, invariant #2 enforced at write time, `admin_manual` runs (F-031-b) |
| 2026-09-09 | `version` 3 -> 4: the worker half gets a runtime — `worker-service`, a deployable that serves no requests (ADR-0027). Invariants #1-#3 stop being planned (F-031-a) |
| 2026-09-09 | `draft -> active`, `version` 2 -> 3: `bot_integration` gets its first service — the directory `platform/messenger` resolves a webhook path through, plus the internal seam `bot-service` asks over (F-066-i, spec: F-320 F-321 F-323) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
