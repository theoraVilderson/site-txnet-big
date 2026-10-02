---
id: ai
layer: domain
status: draft
version: 2
updated: 2026-10-02
---

# Contract — ai

**DRAFT — schema (F-038-a) and `ai-service` (F-038-b): it boots, holds its
pools, gates each trigger on the tenant's package (F-1550) and rebuilds every
account's profile and predictions hourly (F-038-c, F-038-d); nothing is
decided yet.** The design
is ADR-0109; the series that builds it is F-038-b … F-038-w and catalog
area 24 (F-1501 … F-1550).

## TL;DR

Two layers. The **engine** is ours: per-account profiles → predictions with
reasons → a next best action → its timing → a template. It needs no model and
no key. The **language layer** is the tenant's own model (BYO-AI): it may
rephrase a template or re-rank inside the engine's candidates, never invent a
product, number or price. Both run in one service, `ai-service`, so every
guardrail has one home.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| rebuild profiles — **implemented (F-038-c)** | `POST /api/internal/ai/profiles/rebuild`, `ServiceOnlyGuard` (else 404); `worker-service`'s `ai_profile_rebuild`, hourly | `meter_reading`, `account_profile` and `prediction` rows; `{tenants, skipped, accounts, readings, predictions, purged}` in the success envelope | sync, service only | a failing tenant is logged and counted in `skipped`, the others still run |
| decide | an outbox trigger or the hourly run | an `action` row: `scheduled`, `awaiting_approval` or `suppressed` (+ step) | async | — |
| record outcome | the purchase or top-up the action suggested, within 7 days | `action.status = accepted` | async | — |
| settings, offers, providers | tenant admin | `setting`, `offer`, `guardrail`, `provider`, `task_route` | sync (F-038-j, F-038-w) | — |

## Emits (events)

None yet. Delivery is a notice of class `suggestion` through `notification`
(F-038-g, ADR-0109 point 11).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | status key `tenant:status:<id>` (`policy/tenant-sells.ts`, F-038-x); `ai_recommendation` feature key via `TenantEntitlements`, read per trigger with `ai.setting` and active providers (`policy/ai-tenant-policy.ts`, F-1550) | the trigger fails and is dead-lettered; nothing runs unchecked |
| identity, billing, entitlement, catalog, tenant | the tables in `ai-service/src/app/reader/reader-tables.ts`, through `txnet_ai_reader` — SELECT only, `identity.user` by named columns, each under its tenant clause (ADR-0109 point 6) | that run is skipped; nothing is guessed |
| identity, billing, notification | `ai.reader_sign_in`, `ai.reader_wallet`, `ai.reader_notice` — the user-keyed tables, through views scoped by the user's tenant (F-038-c, data-model "Access rules") | as above |
| automation | `AI_TRIGGER_EVENTS` (`triggers/trigger-events.ts`) on its own queue `txnet.ai.triggers`; a bad envelope or a failed handler is dead-lettered, never requeued | profiles still rebuild hourly |

## The profile (F-038-c) — implemented

`ProfileBuilder` (`profile/`), per running tenant (`AiTenantPolicy`, as a
trigger), 500 accounts a page, all of it pure past the reads
(`profile-features.ts`):

- **Meter readings.** Each active Grant's counters — `consumedBytes` as
  `vpn.traffic`, every other `grant_meter.consumed` by its key — sampled on the
  UTC hour (`meter-readings.ts`): a baseline (`delta` 0) the first time,
  then a row only for an hour the counter grew; a smaller counter is a new
  baseline. A second run in the hour adds its growth to that hour's row.
- **Inputs, 180 days:** Grants (active, or changed in the window), renewals,
  readings, wallet and its ledger, payments, sign-ins, notices.
- **`features`** (`AccountFeatures`, `version` 1): Grants by state, next end,
  last end; renewals; hours used; wallet available = balance − held, as a
  decimal string with its currency (C-02); top-ups; payments succeeded /
  failed / with a coupon; sign-ins and notices of the last 30 days; last
  activity.
- **`activeHours`**: 168 UTC hour-of-week shares (Monday 00:00 = 0) summing
  to 1, each event halved every 28 days; an hour used, a sign-in, a read and a
  paid payment are events. No activity is 168 zeros — unknown, not "never".
- Readings older than 180 days are deleted by the same run (invariant 10).

Tenant subjects (a reseller, point 4) are not profiled yet.

## Predictions v1 (F-038-d, point 7) — implemented

`predictions.ts`, pure, from the same inputs plus each variant's price in
force (the tenant's own before the platform's) and the tenant's deposit
presets (`billing.deposit_setting`). One row per kind per account, replaced
hourly; every one has `reasons[]` — a `code` and its numbers, never prose.

| kind | for | `value` / `predictedAt` | rule |
|---|---|---|---|
| `meter_exhaustion` | the prepaid bag running out soonest, before its end, within 90 days | days / the instant | F-602's rate (72 h, ≥ 24 h observed — `FORECAST_*` in shared-core) from readings; spread by hour of week once readings reach back 7 days |
| `renewal_probability` | the paid Grant ending soonest, within 30 days | 0–1 / its end | 0.5, +0.2 renewed before, ±period use, −0.2 idle 7 days, +0.05 signed in, −0.1 failed payment; clamped 0.02–0.98 until calibration (200 outcomes, later) |
| `right_size` | a prepaid bag with measured renewal periods | size factor / — | < 40 % in each of the last two → down (the larger share); ran out early in two of the last three → up (planned ÷ actual length) |
| `wallet_need` | the paid Grant ending soonest with a price | amount + `currencyCode` / its end | 2 × price − (balance − held), up to the smallest covering preset (past the largest, its multiple); none across two currencies |
| `trial_conversion` | only trials, one live or ended ≤ 14 days, never paid | 0–1 / trial end | 0.15, use, return days, a read, a top-up |
| `win_back_window` | no active Grant, had one | days since / next of 14·30·60 | none past 60 days |

## Factory default (F-1550, ADR-0109 point 12) — implemented

`resolveAiMode` (`policy/ai-defaults.ts`) is the whole rule:

| the tenant | engine | action types | language layer |
|---|---|---|---|
| may not sell (F-038-x): `suspended`, `terminated` or onboarding — the `sell` cell of `TenantStatusPolicy`, from `tenant:status:<id>` | **no run**, entitled or not | none | off |
| package without `ai_recommendation` | **no run**, whatever `ai.setting` says | none | off |
| with it, no `ai.setting` row, no provider | runs | every v1 type (`AI_V1_ACTION_TYPES`: not `cross_sell`, `wheel_invite`, `referral_invite`) | off — templates |
| with it, `engineEnabled = false` | no run | none | off |
| with it and an active provider | runs | v1 minus `disabledActionTypes` | on: per type `draft_with_approval`, or `automatic` if listed in `automaticActionTypes` (F-1543) |

A trigger with no `tenantId` in its payload is acknowledged and skipped,
never assigned a tenant. A missing, unreadable or unreachable status key
refuses nobody (F-018-f's trade, as `worker-service`'s `TenantStatusGate`).

## Who pays attention (F-1502, point 10) — implemented

Every message `ai-service` sends passes `AttentionBudget.spend` (`attention/`,
documented in `engagement`) with its `MessageOrigin`: `engine` — the engine
chose to speak — is charged against the subject's budget (F-1501); `reply` —
an answer to the user's own question — is always allowed, charged nothing and
never reads the table, so a spent budget cannot silence an answer.

## Decision steps (point 8) — built ahead of the pipeline (F-038-e)

Each step is pure and answers `pass`, or the `suppressedBy` it writes on a
`suppressed` action:

| step | rule | `suppressedBy` |
|---|---|---|
| threshold (F-1503) — `decision/confidence-threshold.ts` | confidence below the tenant's `confidenceThreshold` (default 0.6) is dropped; equal passes; compared at 4 places, as stored; a non-number is dropped | `confidence_threshold` |
| opt-out (F-1505) — `decision/opt-out.ts` (`OptOuts.verdict`), from `ai.opt_out` | a subject × type with a row is dropped, permanently | `opt_out` |
| cooldown (F-1504, D-12) — `decision/cooldown.ts`, read by `CooldownReader` from `ai.action` | per subject × type: 14 days rolling from `sentAt` of a `sent`/`accepted`/`dismissed` one; a `scheduled`/`awaiting_approval` one holds it with no reopening time; `suppressed`/`expired` start nothing | `cooldown` |

**The tap (F-1505).** `POST /api/internal/ai/actions/:actionId/opt-out`
(service token only) with `{ tenantId, subjectKind, subjectId }` — the subject
the caller authenticated, never one the message names. The action is found only
as that subject's (else 404); then its type is opted out (`ai.opt_out`, a
second tap a no-op), the action goes `sent` → `dismissed`, and every
`scheduled`/`awaiting_approval` one of the type is `suppressed` by `opt_out`.
Answers `{ actionType }`. Callers: the bot button (F-038-g), the panel card (F-038-h).

## Guarantees (intended)

- Every row is one tenant's (invariant 1); no learning across tenants.
- A suggestion never moves money, a meter or a payment (invariant 4).
- Without a provider, every message is a template (F-1540).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `user_behavior_event`, `ai_recommendation`, `ai_guardrail_rule`, `ai_guardrail_violation_log` | 2026-10-02 | removed (F-038-a) | `action`, `prediction`, `guardrail`, `offer` |
