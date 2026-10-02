---
id: ai
layer: domain
status: draft
version: 2
keywords: [ai, recommendation, guardrail, suggestion, revenue engine, prediction, holdout, opt-out, provider, byo-ai]
source: [txnet-backend/prisma/domains/ai.prisma]
owns_tables: [account_profile, prediction, action, offer, guardrail, holdout, opt_out, provider, task_route, usage, setting]
depends_on: [identity, billing, automation]
updated: 2026-10-02
---

# AI

**Responsibility (one sentence):** the revenue engine (ADR-0109) — per-account profiles, predictions with reasons, the next best action and its timing, offers and guardrails — plus the tenant's own language model (BYO-AI) behind it, with every model call and proactive suggestion decided in `ai-service`.
**Explicitly NOT responsible for:** delivering a message (`notification`, class `suggestion`), applying an accepted offer (`billing` coupon path), setting a price, or reading network data (ADR-0109 point 6).

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
| 2026-10-02 | v2 — schema rebuilt per tenant with RLS (F-038-a, ADR-0109); old tables dropped |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
