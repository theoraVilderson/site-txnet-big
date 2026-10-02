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
| 2026-09-04 | How do behaviour signals arrive? | resolved | **ADR-0021 outbox for real-time triggers; hourly profile rebuild from the database and Redis** (ADR-0109 point 6). No raw event table yet — F-038-c decides whether one is needed | -> ADR-0109 |
