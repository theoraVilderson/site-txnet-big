---
id: automation
layer: domain
status: active
version: 3
keywords: [automation, worker, scheduler, cron, background job, bot integration, tenant bot, webhook path, bot role]
source:
  - txnet-backend/auth-service/src/app/automation/**
  - txnet-backend/prisma/domains/automation.prisma
owns_tables: [bot_worker, bot_schedule, bot_execution_log, bot_integration]
depends_on: [tenant]
updated: 2026-09-09
---

# Automation

**Responsibility (one sentence):** the registry, scheduling and run-history of background workers (campaign senders, fraud scanners, aggregators, reconcilers, metering).
**Also owns:** the registry of bots a tenant runs (`bot_integration`) — which bot, on which platform, at which webhook path, in which role.
**Built so far:** `bot_integration` only. The worker half (`bot_worker`,
`bot_schedule`, `bot_execution_log`) is still schema with no service.
**Explicitly NOT responsible for:** the business logic each worker performs (that lives in the domain the worker serves), and any bot's credentials (the Credential Vault in `tenant` holds those).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing automation from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | `draft -> active`, `version` 2 -> 3: `bot_integration` gets its first service — the directory `platform/messenger` resolves a webhook path through, plus the internal seam `bot-service` asks over (F-066-i, spec: F-320 F-321 F-323) |
| 2026-09-09 | `version` 1 -> 2: `bot_integration` added, several bots per tenant with roles (F-066-h, spec: F-315 F-316) |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
