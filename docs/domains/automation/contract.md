---
id: automation
layer: domain
status: active
version: 3
updated: 2026-09-09
---

# Contract — automation

**Partly implemented.** `bot_integration` has a service —
`auth-service/src/app/automation/` (F-066-i) — and the worker half is still
schema only, so every row about `bot_worker`, `bot_schedule` and
`bot_execution_log` below is intent derived from
`txnet-backend/prisma/domains/automation.prisma`.

## TL;DR

Two things live here. Every background worker is a `bot_worker` row (with a
`key` like `fraud_scanner`, `traffic_aggregator`, `tenant_usage_metering`);
`isActive=false` is the fastest kill switch, schedules are `always_on`,
`time_window` or `cron_expression`, and each run writes a `bot_execution_log`.
Separately, every bot a tenant owns is a `bot_integration` row — the registry
`platform/messenger` resolves an inbound webhook against.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| register worker | key, name, category | `bot_worker` | sync | duplicate key |
| set schedule | botWorkerId, type, window/cron, timezone | `bot_schedule` | sync | invalid cron |
| toggle worker | botWorkerId, isActive | updated row + audit | sync | — |
| record run | botWorkerId, trigger, metrics | `bot_execution_log` | async | — |
| resolve webhook path | webhookPath | `BotIntegration` (tenant + platform + role + `credentialRef`) | sync | unknown path — a 404, never a hint |
| list a tenant's bots | tenantId | `BotIntegration[]`, never a credential | sync | — |
| register / retire a bot | tenantId, platform, botUsername, role | `BotIntegration` | sync | duplicate `(tenant, platform, username)`; second `primary` |
| record a registration outcome | integrationId, ok | `status` + `lastErrorAt` | sync | — |

## BotIntegration — several bots per tenant (F-315, F-316)

One row is one bot. `role` says what it is for, and **C-05** is the whole point
of the distinction: the `primary` bot carries OTP and transactional alerts,
while `sales` / `support` / `secondary` exist for campaigns, secondary brands
and spreading ban risk across accounts. Exactly one `primary` per
`(tenantId, platform)` — see `invariants.md` #5.

**The token is not here.** `credentialRef` is the `label` half of a vault
`CredentialRef`; the other two halves are the row's own `tenantId` and the
kind its `platform` implies (`telegram_bot_token` / `bale_bot_token`). A caller
that needs the token asks the Credential Vault for it and gets an audit row
written on its behalf (`domains/tenant/contract.vault.md`, ADR-0026). There is
no `botTokenEncrypted` column to select by accident.

**The webhook secret is not here either**, and that is a decision this row
makes rather than inherits. The catalog block lists `webhookSecret` as a
column; ADR-0026 rule 1 says a tenant-owned secret lives in the vault and
nowhere else, and `webhook_secret` is already a `TenantCredentialKind`. So it
is a vault row under the *same* `credentialRef` label as the token, which also
buys the thing a column could not: rotating the secret keeps an in-flight
update verifiable through ADR-0026 decision 4's grace window, because `verify`
honours the superseded version. Recorded in `open-questions.md` as a departure
from the catalog's field list, not from its intent.

`status` replaces the old `isActive` boolean because "not running" now has
causes worth telling apart — `pending` (never provisioned), `disabled` (a human
switched it off), `error` (upstream refused it, with `lastErrorAt`).
`capabilities` caches what the platform's driver reports (`platform/messenger`,
F-301); absent means not probed yet.

**`bot_integration` is deliberately not a `TENANT_SCOPED_MODELS` entry**
(`platform/tenant-context`). The ambient scope is opened from a *resolved*
request, and a webhook is resolved by its path in order to discover which
tenant it belongs to — before any tenant exists to scope by. This is the same
exception the vault tables take, and for the same reason.

## What is built, and where the answers go (F-066-i)

`PrismaBotIntegrationDirectory` implements `platform/messenger`'s
`BotIntegrationDirectory` port over this schema and `tenant`'s vault. It is the
only code that reads `bot_integration`, which is what keeps §8 true while the
row is consumed by a unit that owns no table.

Every read here is **cross-tenant** (`runAcrossTenants`), and that is not an
oversight: a webhook path is looked up *in order to discover* which tenant an
update belongs to, so there is no scope to read it under — the lookup is what
opens one. The confinement is the path itself, unguessable and unique.

A second consumer has no database at all. `bot-service` serves the webhook and
reaches this through `POST /api/internal/bot-integrations/*`
(`interfaces/auth-api/contract.md`), behind `ServiceOnlyGuard` and marked
`@TenantAgnostic` — a route that resolves a tenant cannot be made to have one
first. Two of those routes hand back a plaintext credential, which F-323 forbids
*any API* from returning: the reading taken is that F-323 governs the tenant and
admin surfaces, and that this seam already carries a strictly larger power
(captcha bypass for every chat, ADR-0011). Every such call writes a vault audit
row naming `bot-service` as the caller, so F-1215's trail is unbroken.

## Emits (events)

None planned yet — no message bus is wired up.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| tenant | the Credential Vault, for the token and webhook secret a `credentialRef` names | the bot cannot be dialled; the row stays, the send fails |

Workers call into other domains, but no FK dependency exists in the schema.

## Guarantees (intended)

- Toggling `isActive` takes effect on the next scheduler tick.
- `triggeredBy` distinguishes `cron` / `admin_manual` / `event` runs.
- A webhook path resolves to at most one bot — `webhookPath` is globally
  unique, so a path is the whole address and nothing about the sender is
  trusted before it resolves (ADR-0009).
- A tenant always has at most one `primary` bot per platform, enforced by a
  partial unique index rather than by service discipline.
- No operation here returns a bot token to a caller that did not name the exact
  integration it is about to send as, and none returns one to a tenant-facing
  surface at all (F-323).

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| — | — | — | — |

`tenant.TenantBotIntegration` was **removed**, not deprecated, in
`20260909000200_bot_integration`: it had never been written and no code had ever
read it, so there was no consumer to keep a shape for (§8).
