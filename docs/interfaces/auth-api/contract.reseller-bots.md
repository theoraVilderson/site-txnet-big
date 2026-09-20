---
id: auth-api
layer: interface
status: active
version: 28
updated: 2026-09-20
---

# Contract — auth-api / a named reseller's bots

A topic file of [contract.md](contract.md) (§10), opened because that file is at
its 250-line cap. The wire shapes of `/api/auth/tenants/:tenantId/bots`, where a
reseller's bot is connected and retired (F-066-w5, ADR-0064). Business semantics
— the order a connect runs in, what a retire revokes, why this lives in
`auth-service` — are
[automation/contract.bots.md](../../domains/automation/contract.bots.md); this
file is shapes, codes and limits.

Field schemas live in code:
`txnet-backend/auth-service/src/app/automation/reseller-bot.schema.ts`.

## Routes

Every route needs a **Bearer** token and **no permission**: the door is
`ResellerAccess` (tenant invariant 21) — the reseller's owner, one of its staff
seats holding `tenant.manage`, or the platform owner's staff — judged against
the **reseller the path names**, never the session's tenant. A `bot` object is
`{id, platform, botUsername, role, status}` and carries no credential, no
`webhookPath` and no `credentialRef` (F-323, ADR-0009).

| Route | Body / query | Answers | Rate limit | Auth |
|---|---|---|---|---|
| GET  `/auth/tenants/:tenantId/bots` | — | 200 `{bots:[bot]}` — that reseller's bots, platform then handle. Admitted under `read`, so a suspended reseller still sees what it has | 60 / 900s per caller (`RESELLER_BOT_READ_RATE_LIMIT`) | Bearer + `ResellerAccess` |
| POST `/auth/tenants/:tenantId/bots` | `platform` (`telegram`\|`bale`), `token` 1-200. `.strict()` — a body carrying `tenantId` or `role` is refused, not ignored | 201 `{bot, registered}`. **201 with `registered:false` is a real outcome**: the bot is connected and the messenger refused the webhook, so the row is `pending` and `bot-service` re-registers it on its next boot — a client renders that, it does not retry. 400 `invalid_token` (the messenger does not know it), 409 `bot_already_connected` / `primary_exists`, 503 `vault_unavailable` | 10 / 900s per caller (`RESELLER_BOT_WRITE_RATE_LIMIT`) | Bearer + `ResellerAccess` (`staffWrite`) |
| DELETE `/auth/tenants/:tenantId/bots/:platform/:botUsername` | — | 200 `{retired:true, webhookRemoved}`. The bot is named by its `@handle`, never by its path — the path is a credential, so it is neither an input nor an output. `webhookRemoved:false` means the token was revoked and the row deleted but the platform was never told: it keeps posting to an address that now 404s. 404 for an unknown platform, an unknown handle and another reseller's bot alike | 10 / 900s per caller (shared with `POST`) | Bearer + `ResellerAccess` (`staffWrite`) |

## Refusals

`ResellerAccess`'s four, and this surface's five, each as `{reason}`:

| Status | `reason` |
|---|---|
| 400 | `invalid_token` |
| 403 | `not_allowed`, `reseller_suspended` |
| 404 | `reseller_not_found` (platform staff only — nobody else learns a reseller exists), `bot_not_found` |
| 409 | `bot_already_connected`, `primary_exists`, `reseller_terminated` |
| 503 | `vault_unavailable` — this deployment has no KEK and cannot store or revoke a token |

Both buckets are counted the way every other one is
([contract.rate-limits.md](contract.rate-limits.md)): per tenant, under the
platform ceiling, with the default in auth-service's env schema. The write
budget is deliberately the tightest authenticated one on this service —
a connect calls a messenger with a value the caller supplied, so an unbounded
one is a way to test stolen tokens through this platform.

## Consumers

`panel-web` — the reseller workspace's bot screen, `/my-resellers/:id/bot`
(F-066-w6, [panel-web/contract.reseller-bot.md](../panel-web/contract.reseller-bot.md)). No other client, and no service caller: this is a
person's surface, and the internal seam over the same table is
`/internal/bot-integrations/*` in [contract.md](contract.md).
