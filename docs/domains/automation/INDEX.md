---
id: automation
layer: domain
status: draft
version: 1
keywords: [automation, worker, scheduler, cron, background job]
source: []
owns_tables: [bot_worker, bot_schedule, bot_execution_log]
depends_on: []
updated: 2026-09-04
---

# Automation

**Responsibility (one sentence):** the registry, scheduling and run-history of background workers (campaign senders, fraud scanners, aggregators, reconcilers, metering).
**Explicitly NOT responsible for:** the business logic each worker performs (that lives in the domain the worker serves).

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
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
