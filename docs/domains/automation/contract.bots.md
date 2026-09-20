---
id: automation
layer: domain
status: active
version: 8
updated: 2026-09-20
---

# Contract — automation: connecting a reseller's bot

A topic file of [contract.md](contract.md) (§10): the three routes a reseller's
bot is connected, listed and retired through. `bot_integration` itself — the
roles, the vault label, why the table is not tenant-scoped — is in
`contract.md`; the *inbound* webhook is `interfaces/bot-app/contract.webhook.md`;
rotating a live path is [contract.md](contract.md)'s `/auth/bots` route.

## The surface (F-066-w5, ADR-0064)

`/api/auth/tenants/:tenantId/bots` (`auth-service/src/app/automation/reseller-bot.*`):
`GET` list, `POST` connect, `DELETE :platform/:botUsername` retire — for the
reseller the **path** names, which is how the onboarding console finishes its
bot step (F-066-w6).

**In `auth-service`, and that was the open question this row closed** (user,
2026-09-20). ADR-0064 gives each configuring service a second route set beside
its ambient one, and `automation` has one home: the table, the Credential Vault
and the Bot API calls are all in this process already — `WebhookRotationService`
registers a webhook from here today. `bot-service` owns the inbound door and has
neither a database nor a vault, so serving the form there would mean a new
internal seam carrying a plaintext token in the opposite direction, which is the
one thing F-323 exists to prevent.

| Rule | Why |
|---|---|
| The door is `ResellerAccess` (tenant invariant 21, `tenant/contract.entitlements.md`) and no permission: the reseller's owner, one of its staff seats holding `tenant.manage`, or the platform owner's staff. `read` to list, `staffWrite` to write, judged against the **reseller's** status matrix. The work then runs in that reseller's scope | a reseller's owner is the platform's customer, not one of its operators, and holds no operator permission |
| The tenant is the path's alone — the body has no `tenantId` (`.strict()` refuses one) and the session's is never read | the owner signs in to the platform owner's tenant (ADR-0059), so the ambient id would configure the wrong tenant |
| A connect is **prove, store, create, register**, in that order. The token is checked against the messenger (`getMe`) before anything is written; both credentials go to the vault; the row is created `pending`; the webhook is registered last | a row whose token is missing is the one state `BotClientRegistry` cannot recover from, while a vault row no integration points at is invisible and swept by `vault_credential_retention`. The same order the F-069 seeder settled on |
| The `@handle` comes from `getMe`, never from the caller | it is half of `(tenantId, platform, botUsername)`, and a typed one would file the row under a name no deep link resolves to |
| A row that collides after the credentials are written has them **revoked** before the refusal is raised | otherwise a failed connect leaves a live token in the vault |
| Both vault rows carry the acting user as `createdBy` | a credential a person pasted should say which person — unlike the F-069 seeder, which no human runs and which leaves the column null |
| Registration is allowed to fail: the row stays `pending` (which is registrable, so `bot-service` picks it up on its next boot) and the answer carries `registered: false` | a messenger that is down is a bot that is quiet, not a connect that did not happen — and a screen told only "created" leaves a reseller waiting for a bot nobody was told about |
| Every bot connected here is the `primary` (C-05). A second one on the same platform is `primary_exists`, never a silent demotion | the primary carries OTP and transactional alerts; F-315's `sales` / `support` / `secondary` have no surface yet |
| A retire is **withdraw, revoke, delete**: `deleteWebhook` upstream, both vault rows revoked, then the row deleted (the user's call, 2026-09-20 — not `disabled`, which already means a reversible pause a human chose). `deleteWebhook` returning `false` is reported, not waited on; the revoke is not best-effort | the only state a part-way failure may leave is a bot whose token is already dead. A messenger still posting to a retired path gets the same 404 an unknown path gets; a token still working would be a real one |
| No answer carries the token, the webhook secret, the `webhookPath` or the `credentialRef` — a bot is `{id, platform, botUsername, role, status}` | F-323, and ADR-0009: the path is the bot's whole address and therefore a credential, which is also why a retire names the bot by its `@handle` |
| A deployment with no KEK refuses every verb with `vault_unavailable`, checked before the messenger is called | a retire that could not revoke would report a bot as gone while its token still worked |

Refusals name their `reason`: 400 `invalid_token`; 403 `not_allowed`,
`reseller_suspended`; 404 `reseller_not_found` (platform staff only),
`bot_not_found`; 409 `bot_already_connected`, `primary_exists`,
`reseller_terminated`; 503 `vault_unavailable`. Rate limits:
`reseller-bot:read` / `reseller-bot:write` per caller — the write budget is a
security control too, since a connect calls a messenger with a caller-supplied
value. Proof: `reseller-bot.service.spec.ts`.

## What this added to `messenger`

Two Bot API calls and one way to build a driver, all of them F-066-w5's:

- `TelegramLikeBotClient.getMe()` — who a token belongs to, or `null` for every
  failure alike (a revoked token, a typo and a messenger that is down are one
  answer to a caller: *this token cannot be used*).
- `TelegramLikeBotClient.deleteWebhook()` — the withdrawal half of `setWebhook`.
- `BotClientRegistry.clientForToken(platform, token)` — the only entry point
  there that takes a plaintext token from its caller, for the one moment before
  a token is in the vault. It writes no audit row because it decrypts nothing;
  the trail for that moment is the row the caller goes on to create.
