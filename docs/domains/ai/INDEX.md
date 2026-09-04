---
id: ai
layer: domain
status: draft
version: 1
source: []
owns_tables: [user_behavior_event, ai_recommendation, ai_guardrail_rule, ai_guardrail_violation_log]
depends_on: [identity, billing, automation]
updated: 2026-09-04
---

# AI

**Responsibility (one sentence):** the recommendation engine: a high-volume user-behaviour event stream, generated recommendations, and financial guardrail rules that can block or cap a recommendation before a user sees it.
**Explicitly NOT responsible for:** applying an accepted recommendation (`billing`/`catalog`), running the generation worker (`automation`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing ai from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
