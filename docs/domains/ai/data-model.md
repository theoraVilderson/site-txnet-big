---
id: ai
layer: domain
status: draft
updated: 2026-10-02
---

# Data model — ai

Source of truth: `txnet-backend/prisma/domains/ai.prisma` (Postgres schema
`ai`), rebuilt by F-038-a (`20261002000200_ai_schema_rebuilt`, ADR-0109
point 5). The onboarding tables (`user_behavior_event`, `ai_recommendation`,
`ai_guardrail_*`) were empty and are dropped.

## Tables owned
Every table has a NOT NULL `tenantId` and strict RLS (`tenant_isolation`,
`cross_tenant`) from its first migration.

| Table | Purpose | Key | Retention |
|---|---|---|---|
| account_profile | one account's features (`features` JSON) and 168 hour-of-week `activeHours` on UTC; rebuilt hourly | (tenantId, subjectKind, subjectId) | while the account exists |
| prediction | one `AiPredictionKind` for a subject: `value` / `predictedAt`, `confidence` 0–1, `reasons` (non-empty array, CHECK) | id | rebuilt; erased with the account |
| action | the audit of every suggestion, sent or stopped (F-1509): type, status, `suppressedBy` (set iff `suppressed`), reasons, template key, `renderedBy`, expected margin + currency | id | erased with the account |
| offer | a tenant-defined offer: exactly one of coupon template / variant (CHECK), max discount 0–100%, daily budget + currency | id | permanent |
| guardrail | a tenant's cap, one row per key (shape-checked, value ≥ 0; keys checked in code) | (tenantId, key) | permanent |
| holdout | subjects in the tenant's holdout, recorded so a report reads the set the pipeline used | (tenantId, subjectKind, subjectId) | permanent |
| opt_out | a subject's permanent opt-out of one action type | (…, actionType) | permanent |
| provider | a BYO-AI provider: ownership, driver, base URL, key fingerprint (key in the vault), proxy, status | id | until removed |
| task_route | which provider and model a task (message key) uses | (tenantId, task) | until changed |
| usage | calls and tokens per provider, task, UTC day | (tenantId, providerId, task, day) | permanent |
| meter_reading | one Grant meter's counter in one UTC hour and its growth (`delta` ≥ 0, CHECK); a baseline the first time, then only hours it grew (F-038-c) — the engine's usage rate, since it reads no network table | (tenantId, grantId, meterKey, hour) | **180 days**, purged by each rebuild (point 14) |
| setting | one row per tenant; no row = defaults: engine on, no type disabled, model text draft-with-approval, threshold 0.60, holdout 10% (CHECK 5–20), PII scrub on, 3000 ms | tenantId | permanent |

Not owned here, but written only by `ai-service`: `engagement.attention_budget`
(F-1501, created in the same migration, documented in `engagement`).

`subjectKind` is `user` or `tenant`. A reseller as a subject (ADR-0109 point 4)
is a row in the **platform's** tenant with `subjectId` = the reseller's tenant id.

## Relationships crossing unit boundaries
No foreign keys leave the schema; ids are plain UUIDs.

| This column | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| `subjectId` (kind `user`) | -> | identity.user.id | the account a suggestion is about |
| `subjectId` (kind `tenant`) | -> | tenant.tenant.id | a reseller as the platform's customer |
| offer.couponTemplateId / variantId | -> | billing coupon template / catalog variant | an offer is redeemed on the existing coupon path |

## Access rules

Only `ai-service` writes these tables, on the app pool with the tenant bound.
Its reads of other units go through `txnet_ai_reader` (invariant 7). Tables
keyed by user with no `tenantId` and no RLS (`billing.wallet`,
`identity.session`, `notification.notification`) are read through three
`security_barrier` views, `ai.reader_wallet` / `reader_sign_in` /
`reader_notice` (`20261002000400`, F-038-c): the row's user must be in the bound
tenant, only named columns (no IP, user agent, token hash, notice text), and
only the reader may SELECT them. They run as their owner, the migration's
superuser; owned by a role under `FORCE` RLS on `identity.user`, they would
return nothing — fail closed. No Prisma model: read with raw SQL.
