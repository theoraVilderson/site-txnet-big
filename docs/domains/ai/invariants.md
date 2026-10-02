---
id: ai
layer: domain
status: draft
updated: 2026-10-02
---

# Invariants — ai

**DRAFT** — the schema enforces 1–3, the role 7, compose 8, `ai-service` 9 and 10; 4–6 are ADR-0109 rules still to build.

| # | Invariant | Enforced by | Blast if violated |
|---|---|---|---|
| 1 | Every `ai.*` row and `engagement.attention_budget` row belongs to one tenant; the app pool sees only the current tenant's | NOT NULL `tenantId` + strict RLS (`20261002000200`); `ai-schema-rebuilt.spec.ts`, `rls-coverage.spec.ts` | one reseller reads another's customers |
| 2 | A prediction and an action always say why: `reasons` is a non-empty array; a `suppressed` action names the step | CHECKs `*_reasons_present`, `action_suppressed_says_by_what`; `predictions.spec.ts` | an unexplainable suggestion |
| 3 | Holdout share is 5–20% (never 0); confidence threshold 0–1; an offer targets exactly one thing with a discount ≤ 100% | CHECKs on `setting`, `offer` | no measurement; a free product |
| 4 | The engine never sets a price, writes the ledger, changes a meter or touches the payment path | ADR-0109 point 9, §24.5 — service layer (planned) | money moved by a suggestion |
| 5 | No learning across tenants and no network-layer data as input | ADR-0109 point 6 — service layer (planned) | one tenant's data shapes another's suggestions |
| 6 | The attention budget is a count of messages, never a ledger account | C-13; `AttentionBudget` stores charge times only (`engagement` invariant 6) | budget mixed with money |
| 7 | `ai-service` reads other units only through `txnet_ai_reader`: SELECT on named tables and the three `ai.reader_*` views, nothing under `network`, no contact or secret column of `identity.user`, one tenant's rows | `20261002000300_ai_reader_role`, `…0400_ai_profile_inputs`, `db-login-roles.sh`; `reader-role.spec.ts`; the reader URL may not equal the app URL (`env.validation.ts`) | the engine writes another unit's tables, or reads another tenant's |
| 8 | The container is capped at one CPU and a memory ceiling | `dev-docker/compose/ai-service.yml` | the live site and bot on this host starve |
| 9 | No engine run for a tenant that may not sell (suspended, terminated, onboarding — F-038-x) or whose package lacks `ai_recommendation`; with it, every v1 type runs on templates with no configuration, and model text needs a provider and starts as draft-with-approval | `resolveAiMode` + `AiTenantPolicy`, called by `TriggerConsumer`; `ai-defaults.spec.ts` | unpaid feature, or messages nobody configured |
| 10 | A raw behaviour event (`ai.meter_reading`) lives 180 days; a reading never goes negative and an idle hour writes no row | `ProfileBuilder.rebuildTenant` purges; CHECK `meter_reading_delta_not_negative`; `readingsFor` + `profile-features.spec.ts` | data kept past what point 14 allows; a wrong usage rate |

## How to test

Schema rules: `shared-core/src/lib/prisma/ai-schema-rebuilt.spec.ts`. Service
rules: with `ai-service` (F-038-b onward).
