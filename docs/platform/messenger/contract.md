---
id: messenger
layer: platform
status: draft
version: 1
updated: 2026-09-05
---

# messenger — contract

**Nothing here is implemented.** This is intent (§0 authority level 4). The
authority on what a platform actually supports is that platform's live API, and a
capability flag is a *claim about it* that must be verified before it is trusted.

## TL;DR

One driver per messenger. Everything above this unit speaks `BotView` and asks
`capabilities`; nothing above it names Telegram or Bale.

## The two shapes this unit exposes

### `BotView` — what a screen is (consumed, not owned)

Owned by `bot-app` (see its contract). `messenger` only renders it. The rendering
contract is the whole point of the split: a `BotView` names *intent* (a choice
between N options, a document to hand over, a chart to show), never a widget.

### `capabilities` — what a platform can do (`F-301`)

A per-platform record consulted before rendering. **Source of truth: each
platform's official documentation, read and dated** (user decision, 2026-09-05).
A flag is never assumed and never inferred from Telegram.

Verified against [docs.bale.ai](https://docs.bale.ai/) and
[docs.bale.ai/miniapp](https://docs.bale.ai/miniapp) on **2026-09-05**:

| axis | Telegram | Bale | diverges? |
|---|---|---|---|
| inline keyboard | yes | yes (`InlineKeyboardMarkup`, incl. url / callback / web_app / copy-text) | no |
| reply keyboard | yes | yes (`ReplyKeyboardMarkup`, incl. request contact/location) | no |
| photo upload | 10 MB multipart / 5 MB by URL | 10 MB multipart / 5 MB by URL | no |
| document / video / audio | 50 MB send | 50 MB send | no |
| file download | 20 MB | 20 MB | no |
| Mini App / WebApp | `window.Telegram.WebApp` | `window.Bale.WebApp` | **name only** |
| Mini App identity proof | HMAC-SHA-256 over the sorted data-check-string, secret = HMAC(bot token, `"WebAppData"`) | **the same scheme** | no |
| in-chat payment | provider tokens / Stars | own wallet: `sendInvoice`, `answerPreCheckoutQuery`, `inquireTransaction` | **yes — different rails** |
| API base URL | `api.telegram.org/bot<token>` | `tapi.bale.ai/bot<token>` | **yes** |
| deep link | `t.me/<bot>?start=<payload>` | `ble.ir/<bot>?startapp` | **yes** |
| Bale-only | — | `askReview`, `inquireTransaction`, `showScanQrPopup`, `addToHomeScreen`, a `/business/` path with higher rate limits | n/a |

**What this table actually says.** The catalog's premise — "Bale is a subset of
Telegram" (§10.3) — is *not what the documentation shows*. On presence of
capability the two are near-identical; every real divergence is a difference of
**shape**: a different base URL, a different global object name, a different
deep-link form, and genuinely different payment rails. See ADR-0009's amendment.

That changes what this unit is mostly for. Ranked by real risk:

1. **Payments** — the one place a capability flag in the `F-301` sense earns its
   keep. Two different rails, not one rail with a missing feature.
2. **Deep links** — `?start=<payload>` vs `?startapp`. `F-314`'s payloads
   (`buy_<sku>`, `ref_<code>`, `trial`) need a per-platform encode/decode, and
   the `F-0203` link token already in production is Telegram-shaped.
3. **Naming** — base URL and `window.Bale.WebApp` vs `window.Telegram.WebApp`.
   Cheap to get right, silently broken if hard-coded anywhere above this unit.

**Rule:** every row above carries the date it was verified. A flag with no date
is not a flag. Re-read both platforms' docs before adding an axis, and record
the date in the same change.

### Degradation policy (`F-302`)

When a capability is absent, the renderer **substitutes and continues**. It never
throws, and it never silently drops the user's ability to act:

| missing | substitute |
|---|---|
| inline keyboard | reply keyboard, else a numbered list the flow accepts as text |
| WebApp button | a plain URL to the same `panel-web` route |
| file over the size ceiling | a link to the file, or a lower-fidelity rendering |
| in-chat payment | the invoice flow that already works on the web |

Two hard rules, both from ADR-0009:

- **Degradation is designed, per capability, before the capability is used.** An
  undesigned fallback is a silent failure with a policy's name on it.
- **A substitution is observable.** It is logged with the platform, the
  capability and the view, so "it works on Telegram and not on Bale" is a query,
  not an investigation.

## Bot token resolution

`tenant.TenantBotIntegration` holds `botTokenEncrypted`, `botUsername` and a
`@@unique webhookPath` per `(tenantId, platform)`. This unit resolves *which
credential* an inbound update belongs to and asks `tenant` for it through
`tenant`'s contract — the Credential Vault. It never reads
`tenant.TenantBotIntegration` directly (§8), and it never logs or returns a
token.

## Consumers

| consumer | what it needs |
|---|---|
| bot-app | render a `BotView`; read `capabilities` before offering an affordance |
| identity | outgoing OTP delivery to a proven `LinkedBotAccount` (`F-0202`) |
| notification | campaign + retention sends, rate-limited (`F-313`, §9.8) |

`identity` is already a consumer in code today, through
`otp/senders/bot-client.registry.ts`. That is the second consumer that makes this
a `platform/` unit rather than part of `bot-app` (§1 placement test).

## Webhook addressing

**One unguessable path per bot** (user decision, 2026-09-05; ADR-0009). This is
what `tenant.TenantBotIntegration.webhookPath @unique` already models, and the
live `F-0203` route `POST /auth/bots/:platform/webhook/:secret` is already
per-secret — the same shape, so it converges rather than breaking (§8).

Why per bot and not one shared door: a shared endpoint is one failure point for
every reseller at once, and a token or ban problem on one brand's bot becomes an
outage on all of them. Per path, the blast radius is one tenant.

Consequences this unit must honour:

- The path **is** the credential lookup. Resolving it yields the tenant and the
  platform; nothing about the sender is trusted before that.
- An unknown path answers **404**, never a hint. A path is unguessable or it is
  not a boundary.
- Handling is best-effort and answers **200** once the path is known, so the
  platform never redelivers — the pattern the live `F-0203` webhook already sets.
- Rotating a bot token rotates the path with it, so a leaked path dies too.

## Open

See [open-questions.md](open-questions.md). Where verified capability flags live
is blocking for any implementation item.
