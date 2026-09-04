---
id: engagement
layer: domain
status: draft
version: 1
keywords: [spin wheel, engagement, daily reward, eligibility]
source: []
owns_tables: [spin_wheel_config, spin_wheel_prize, spin_wheel_attempt]
depends_on: [identity, billing, fraud]
updated: 2026-09-04
---

# Engagement

**Responsibility (one sentence):** the daily spin wheel: prize config, strict eligibility checks, and per-attempt records with an eligibility snapshot, under a hard daily financial cap.
**Explicitly NOT responsible for:** crediting the wallet itself (`billing`), deciding what counts as fraud (`fraud`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing engagement from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
