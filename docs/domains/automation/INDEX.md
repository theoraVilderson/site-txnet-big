---
id: automation
layer: domain
status: active
version: 5
keywords: [automation, worker, scheduler, cron, background job, bot integration, tenant bot, webhook path, bot role]
source:
  - txnet-backend/auth-service/src/app/automation/**
  - txnet-backend/worker-service/src/app/**
  - txnet-backend/shared-core/src/lib/automation/**
  - txnet-backend/prisma/domains/automation.prisma
owns_tables: [bot_worker, bot_schedule, bot_execution_log, bot_integration]
depends_on: [tenant]
updated: 2026-09-09
---

# Automation

**Responsibility (one sentence):** the registry, scheduling and run-history of background workers (campaign senders, fraud scanners, aggregators, reconcilers, metering).
**Also owns:** the registry of bots a tenant runs (`bot_integration`) — which bot, on which platform, at which webhook path, in which role.
**Built so far:** `bot_integration`, the worker *runtime* — `worker-service`
registers each job as a `bot_worker`, publishes a tick per due schedule and
appends a `bot_execution_log` per run — the admin surface that writes them,
five `/admin/workers` routes in `auth-service` (F-031-b), and the first job
that does real work: `vault_credential_retention` (F-031-c).
**Explicitly NOT responsible for:** the business logic each worker performs (that lives in the domain the worker serves), and any bot's credentials (the Credential Vault in `tenant` holds those).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing automation from outside |
| [contract.worker.md](contract.worker.md) | the worker runtime, the jobs, `/admin/workers` |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | `version` 4 -> 5: an admin can write what the runtime reads — `/admin/workers` in `auth-service`, invariant #2 enforced at write time, `admin_manual` runs (F-031-b) |
| 2026-09-09 | `version` 3 -> 4: the worker half gets a runtime — `worker-service`, a deployable that serves no requests (ADR-0027). Invariants #1-#3 stop being planned (F-031-a) |
| 2026-09-09 | `draft -> active`, `version` 2 -> 3: `bot_integration` gets its first service — the directory `platform/messenger` resolves a webhook path through, plus the internal seam `bot-service` asks over (F-066-i, spec: F-320 F-321 F-323) |
| 2026-09-09 | `version` 1 -> 2: `bot_integration` added, several bots per tenant with roles (F-066-h, spec: F-315 F-316) |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
