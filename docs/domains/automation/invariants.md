---
id: automation
layer: domain
status: draft
updated: 2026-09-09
---

# Invariants — automation

**DRAFT** — #1–#4 are extracted from schema comments and none are enforced in
code yet. #5–#7 arrived with `bot_integration` (F-066-h) and **are** enforced
today, in the schema and the migration rather than in a service.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | `bot_worker.isActive = false` stops all runs of that worker regardless of schedule | planned service layer / schema | see contract | 
| 2 | `bot_schedule` fields are mutually exclusive per `scheduleType` (window fields vs `cronExpression`) | planned service layer / schema | see contract | 
| 3 | Every run appends exactly one `bot_execution_log` (start), updated on finish — runs are never silent | planned service layer / schema | see contract | 
| 4 | `bot_worker.key` is unique and stable — it is referenced by string | planned service layer / schema | see contract | 
| 5 | **Exactly one `primary` bot per `(tenantId, platform)`** (C-05) | the partial unique index `bot_integration_one_primary_per_tenant_platform`, in the database | "send this tenant's OTP" picks whichever row the planner found first — a code goes to the wrong brand's bot, silently | 
| 6 | A `bot_integration` row holds **no secret** — not a token, not a webhook secret. `credentialRef` names a vault label; the value is fetched through the vault, which audits the read (ADR-0026) | schema shape: there is no column to select | a token in a `SELECT *`, a log line or an admin response, for every tenant at once | 
| 7 | `webhookPath` is globally unique and is the whole address — resolving it yields the tenant and the platform, and nothing about the sender is trusted before it does (ADR-0009) | `@@unique` on the column | a shared door: one bot's token or ban problem becomes an outage for every reseller | 

## How to test

To be written when a service exists.
