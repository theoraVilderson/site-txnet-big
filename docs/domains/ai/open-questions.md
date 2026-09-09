---
id: ai
layer: domain
status: draft
updated: 2026-09-04
---

# Open questions — ai

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | What actually generates recommendations — a rules engine, a classical model, an LLM? No code exists. | yes | ASSUMED(2026-09-04): rules + simple scoring first; model later | -> ADR |
| 2026-09-04 | `confidenceScore` scale (0-1 `Decimal(5,4)`) and `min_confidence_threshold` default? | no | ASSUMED(2026-09-04): 0-1; default threshold 0.6 | -> rules.md |
| 2026-09-04 | Event ingestion: who emits `user_behavior_event` (each domain? an interceptor?) and via what path? | resolved | **Answered 2026-09-09 by ADR-0021: a transactional outbox.** The producer writes its row and its event in one transaction; a relay delivers them. The "synchronous call until a bus exists" assumption is withdrawn. Who emits which event is still this unit's to decide when it is built | -> ADR-0021 |
