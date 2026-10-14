---
id: ai
layer: domain
status: active
version: 2
keywords: [ai, ai admin, ai.manage, at-risk, recommendation, guardrail, suggestion, revenue engine, prediction, holdout, opt-out, provider, byo-ai, suggestion card, uplift, reseller forecast, quota run-out, churn risk]
source: [txnet-backend/prisma/domains/ai.prisma, txnet-backend/ai-service/src/**, txnet-backend/shared-core/src/lib/ai/**]
owns_tables: [account_profile, prediction, action, offer, guardrail, holdout, opt_out, provider, task_route, usage, setting]
depends_on: [identity, billing, automation]
updated: 2026-10-14
---

# AI

**Responsibility (one sentence):** the revenue engine (ADR-0109) — per-account profiles, predictions with reasons, the next best action and its timing, offers and guardrails — plus the tenant's own language model (BYO-AI) behind it, with every model call and proactive suggestion decided in `ai-service`.
**Explicitly NOT responsible for:** delivering a message (`notification`, class `suggestion`), applying an accepted offer (`billing` coupon path), setting a price, or reading network data (ADR-0109 point 6).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing ai from outside |
| [contract.candidates.md](contract.candidates.md) | an action type is added, or the engine proposes the wrong one — when each type is a candidate, what it carries, how it is told (F-038-k) |
| [contract.admin.md](contract.admin.md) | the reseller's AI page reads or changes settings, offers, at-risk lists or the report — `/api/ai/admin/*`, `ai.manage` (F-038-j1) |
| [contract.resellers.md](contract.resellers.md) | a reseller as the platform's customer — its quota run-out and churn predictions, how the platform reads them, its upgrade (F-038-o) |
| [contract.my-suggestion.md](contract.my-suggestion.md) | the panel's suggestion card reads, closes or opts out — ai's routes on `/api/ai` (F-038-h) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |
| 2026-10-02 | v2 — schema rebuilt per tenant with RLS (F-038-a, ADR-0109); old tables dropped |
| 2026-10-14 | **draft -> active** (OPS-1-ab): status caught up with code already shipped (ai-service); no contract change |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
