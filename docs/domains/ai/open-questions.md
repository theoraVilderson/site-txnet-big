---
id: ai
layer: domain
status: draft
updated: 2026-10-02
---

# Open questions — ai

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | What generates recommendations — rules, a classical model, an LLM? | resolved | **Answered 2026-10-02 by ADR-0109:** our statistics-and-rules engine; the tenant's model only rephrases or re-ranks inside its candidates | -> ADR-0109 |
| 2026-09-04 | Confidence scale and default threshold? | resolved | **0–1, default 0.60** (ADR-0109 point 8, F-1503); `setting.confidenceThreshold` | -> ADR-0109 |
| 2026-09-04 | How do behaviour signals arrive? | resolved | **ADR-0021 outbox for real-time triggers; hourly profile rebuild from the database** (ADR-0109 point 6). **F-038-c (user, 2026-10-02):** one raw event table, `ai.meter_reading` — the hourly meter sample, since F-602's rate reads `network.traffic_raw_log`; everything else is already a durable row in its own unit. Redis adds nothing newer (`sub:usage` is the committed counter) | -> ADR-0109 |
| 2026-10-02 | Wallet balance, sign-ins and notice reads live in tables keyed by user with no `tenantId` (`billing.wallet`, `identity.session`, `notification.notification`). How does the profile builder get them? | resolved | **User, 2026-10-02: scoped through the row's user's tenant.** Those tables have no RLS, so the rule is three `security_barrier` views readable by the reader alone, named columns only (data-model "Access rules") | -> F-038-c |
