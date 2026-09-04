---
id: ai
layer: domain
status: draft
updated: 2026-09-04
---

# Data model — ai

Source of truth: `txnet-backend/prisma/domains/ai.prisma` (Postgres schema
`ai`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| user_behavior_event | **monthly partitioned**, BigInt PK; event type + payload JSON | via user | drop old partitions |
| ai_recommendation | type, suggested payload, confidence, est. revenue/cost, status, generating worker | via user | long |
| ai_guardrail_rule | threshold rule (max discount %, max daily discount budget, max recs/user/day, min confidence) | no | permanent |
| ai_guardrail_violation_log | which rule a recommendation violated + action taken | via recommendation | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| user_behavior_event.userId, ai_recommendation.userId | -> | identity.user.id | recommendations target users |
| ai_recommendation.generatedByBotWorkerId | -> | automation.bot_worker.id | the generation worker |
| ai_recommendation.suggestedPayload / est. impact | -> | billing / catalog (coupons, plans, prices) | a recommendation proposes a billing/catalog action |

## Access rules

Draft. No service yet; when built, no unit outside `ai` writes these
tables and reads go through a `ai` service API.

## Migration notes

No migration history is committed. Any partitioning / RLS / partial-unique-index
noted in the schema is "section 99" manual SQL and is **not applied**.
