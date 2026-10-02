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
| 2026-10-02 | `trial_convert` (F-038-l): nothing issues a trial Grant yet (`source = trial`; F-705, area 17.2, not ingested; F-314's `?start=trial` acts on nothing). When does it fire, which plan does it name, and how sure is it? | yes — F-038-l is `blocked` on F-705 | **Decided now, built when trials exist (user, 2026-10-02: "decide it soundly, so it is not forgotten"):** (1) a running trial, never paid, that **connected** (`consumedBytes > 0`) — an unused trial is not pitched; (2) inside the trial's last 24 h, or its last half when shorter than 2 days; deadline = trial end; (3) the plan: the smallest public priced plan of the trial's product holding the trial's daily use × the plan's days × 1.25 (`RESIZE_DOWN_HEADROOM`'s rule), else the largest; with under 24 h of use, the cheapest; (4) `trial_conversion` confidence is fixed at 0.55, under the default threshold 0.6 — a trial that connected gets 0.65, so the type is not dead by default; (5) margin P(conversion) × (price − cost), cost unknown for the platform's own sale as today; (6) converts on any paid invoice for that product inside the window (invariant 22 amended for this type: the product, not one plan). Re-check (3) against F-705's trial shape before building | -> F-038-l |
