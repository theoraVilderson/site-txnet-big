---
id: messenger
layer: platform
status: active
version: 4
updated: 2026-09-09
---

# messenger — contract: integrations and their credentials

A topic file of [contract.md](contract.md) (§10 — that file was at 279 lines).
It covers one question: how a tenant's bot becomes a client that can send.

## One client per integration (`F-320`, contract v4)

`BotClientRegistry` used to build one client per platform out of
`TELEGRAM_BOT_TOKEN` / `BALE_BOT_TOKEN` at boot. That is gone. What comes from
the environment is now only what is true of a *platform* — its API base and its
deep-link host; everything that is a *tenant's* comes from that tenant's
`automation.BotIntegration` row and the Credential Vault.

Every method that used to take a `BotPlatform` now takes a `BotIntegration`:

| ask | answer |
|---|---|
| `byWebhookPath(platform, path)` | the integration an inbound update belongs to, or `null` |
| `primaryFor(tenantId, platform)` | the bot a tenant sends transactional traffic as (C-05) |
| `client(integration, caller)` | a driver, or `null` when the token is not usable |
| `primaryClient(tenantId, platform, caller)` | the two above, together |
| `canSend` / `canLink` / `hasToken` | can this bot send at all — **without decrypting** |
| `verifyWebhookSecret(integration, candidate)` | is this its secret token (F-321) |
| `verifyWebAppInitData(integration, initData)` | who this Mini App signature names (F-310) |
| `deepLink(integration, payload)` | the link, built from that bot's own username |

Two properties of that table are load-bearing and neither is visible at a call
site:

- **No client is cached.** Building one is cheap and holding a token is not: a
  cached client keeps a rotated or revoked token working, and skips the audit
  row every vault decryption writes (ADR-0026 decision 5, F-1215). A cached
  client is a credential held for an unbounded time with nothing recording that
  it was held.
- **The questions asked constantly do not decrypt.** `canSend` is asked on
  every render of the OTP channel list. Answering it with a decryption would
  fill the audit trail with *someone asked* instead of *someone held the
  value*, which is the distinction that trail exists to record.

`caller` is not decoration: it is what the audit row names —
`identity:TelegramOtpSender`, `bot-app:BotDispatcher`.

### The directory port, and why it is a port

`BotIntegrationDirectory` is an interface with two implementations, because the
two apps that consume this unit are not equal below that seam:

| app | implementation | how |
|---|---|---|
| `auth-service` | `automation`'s `PrismaBotIntegrationDirectory` | the schema and the vault are in reach |
| `bot-service` | `AuthApiBotIntegrationDirectory` | `POST /api/internal/bot-integrations/*`, proven by `X-Service-Token` (ADR-0011) |

`MessengerModule.forRoot({ imports })` takes the module that exports
`BOT_INTEGRATION_DIRECTORY` and binds nothing itself. There is deliberately no
default: an app that forgot to supply one would still boot, and the failure
would arrive on the first inbound update rather than at wiring.

**A token never leaves this unit** — a caller hands over an integration and is
handed a driver, or asks a question and is told the answer (F-323). The one
place a plaintext crosses a process boundary is the internal seam above, and
the reasoning for that is in `domains/automation/contract.md`.
