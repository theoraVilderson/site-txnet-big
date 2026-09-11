---
id: messenger
layer: platform
status: active
version: 4
updated: 2026-09-10
---

# messenger — contract

Implemented as the Nx library `@txnet-backend/messenger`
(`txnet-backend/messenger/src/lib/`). The authority on what a platform actually
supports is that platform's live API, and a capability flag is a *claim about
it* that must be verified before it is trusted — never copy a row of the table
below into code, import `capabilitiesOf(platform)`.

| file | holds |
|---|---|
| `bot-integration.ts` | the `BotIntegration` shape and the `BotIntegrationDirectory` port — where integrations and their credentials come from |
| `bot-client.registry.ts` | one client per `BotIntegration`, tokens from the vault through that port |
| `telegram-like-bot.client.ts` | the driver: `sendMessage`, `requestContact`, `deleteMessage`, `answerCallbackQuery`, webhook get/set |
| `capabilities.ts` | the table below, in code, each entry carrying `verifiedOn` + `source` |
| `bot-view.ts` | the `BotView` types (owned by `bot-app`, declared here so both can import them) |
| `renderer.ts` | `BotView` -> payload, with the degradation policy and its log line |
| `deep-link.ts` | the per-platform link shape and the `?start=` payload parser |

Not built yet: media sending (`F-308`), payments (`F-304`) and per-tenant
branding (`F-317`).

## TL;DR

One driver per **bot**, one renderer per messenger. Everything above this unit
speaks `BotView` and asks `capabilities`; nothing above it names Telegram or
Bale, and nothing above it ever holds a token.

See [contract.integrations.md](contract.integrations.md) for how a
`BotIntegration` becomes a client — the registry's shape since F-066-i, and the
port the two consuming apps bind differently.

## The two shapes this unit exposes

### `BotView` — what a screen is (consumed, not owned)

Owned by `bot-app` (see its contract). `messenger` only renders it. The rendering
contract is the whole point of the split: a `BotView` names *intent* (a choice
between N options, a document to hand over, a chart to show), never a widget.

**What the renderer assembles.** A screen is more than a sentence and a
keyboard, so `BotView` carries the parts separately and the renderer joins the
ones that are present, in this order: `hint` (why you are seeing this again),
`header` (where you are), `summary` (what you already answered), `body` (the
question), `footer` (where you can go). Only `body` is required. They are
separate fields rather than one pre-joined string because each is an i18n key
a tenant may reword (`F-317`) — a flow that glued them together would be
authoring copy.

**A contact request keeps the rest of the screen.** Asking for a contact card
requires a reply keyboard, and the other rows used to be dropped to build one —
leaving the one screen a user is most likely to refuse ("share my number") with
nothing to refuse it with. Every remaining non-URL choice now goes on the same
reply keyboard.

### `capabilities` — what a platform can do (`F-301`)

A per-platform record consulted before rendering. **Source of truth: each
platform's official documentation, read and dated** (user decision, 2026-09-05).
A flag is never assumed and never inferred from Telegram.

Verified against [docs.bale.ai](https://docs.bale.ai/),
[docs.bale.ai/miniapp](https://docs.bale.ai/miniapp) and
[core.telegram.org/bots/api](https://core.telegram.org/bots/api) on
**2026-09-05**, re-read and extended with the delete axis on **2026-09-06**:

| axis | Telegram | Bale | diverges? |
|---|---|---|---|
| inline keyboard | yes | yes (`InlineKeyboardMarkup`, incl. url / callback / web_app / copy-text) | no |
| reply keyboard | yes | yes (`ReplyKeyboardMarkup`, incl. request contact/location) | no |
| photo upload | 10 MB multipart / 5 MB by URL | 10 MB multipart / 5 MB by URL | no |
| document / video / audio | 50 MB send | 50 MB send | no |
| file download | 20 MB | 20 MB | no |
| delete an **incoming** message in a private chat | yes, within 48 h | yes, within 48 h (same wording, `deleteMessage`) | no — verified 2026-09-06 |
| Mini App / WebApp | `window.Telegram.WebApp` | `window.Bale.WebApp` | **name only** |
| Mini App SDK the page must load | `https://telegram.org/js/telegram-web-app.js?63` | `https://tapi.bale.ai/miniapp.js?3` | **yes — different URL** (verified 2026-09-10) |
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
4. **The SDK** — *neither* global exists until the page loads that platform's
   own script, and a page that loads none fails **silently**: it simply finds
   no host and shows the ordinary login screen. That is exactly how `F-310`
   shipped broken on 2026-09-08. The page cannot pick the script itself, so the
   bot marks the URL (`?ma=<platform>`, `docs/interfaces/bot-app/contract.md`)
   and `site-pwa/src/lib/mini-app.ts` holds the two URLs above.

**Rule:** every row above carries the date it was verified. A flag with no date
is not a flag. Re-read both platforms' docs before adding an axis, and record
the date in the same change.

### Degradation policy (`F-302`)

When a capability is absent, the renderer **substitutes and continues**. It never
throws, and it never silently drops the user's ability to act:

| missing | substitute | built? |
|---|---|---|
| inline keyboard | reply keyboard with numbered labels, else a numbered list the flow accepts as text | yes — `renderer.ts` |
| contact request button | ask the user to type their phone number | yes |
| WebApp button | a plain URL to the same `panel-web` route | yes |
| file over the size ceiling | a link to the file, or a lower-fidelity rendering | link only |
| delete-message unavailable | tell the user to delete the message themselves | in the flow (`F-303-c`), not the renderer |
| in-chat payment | the invoice flow that already works on the web | no — `F-304` |

`render()` returns the substitutions it made alongside the payload, so a caller
can assert on them; `matchAction()` reads a tap, a number and a label back to the
same action id, which is what makes the numbered-list fallback a real path
rather than a stated one.

Two hard rules, both from ADR-0009:

- **Degradation is designed, per capability, before the capability is used.** An
  undesigned fallback is a silent failure with a policy's name on it.
- **A substitution is observable.** It is logged with the platform, the
  capability and the view, so "it works on Telegram and not on Bale" is a query,
  not an investigation.

## The command menu

`setMyCommands` publishes a bot's command list per language, so `/menu` and
`/help` appear in the messenger's own command menu. Best-effort, like
`setWebhook`: every command it names is also a button in the chat, so a stale
command menu costs discoverability, never a capability. `bot-app` owns the
list and the translations (`BotWebhookRegistrar`).

## Bot token resolution

`automation.BotIntegration` holds `botUsername`, a `@@unique webhookPath`, a
`role`, and a `credentialRef` — the vault *label* both the token and the webhook
secret are stored under, never either value (F-066-h; the old
`tenant.TenantBotIntegration` and its `botTokenEncrypted` column are gone). This
unit resolves *which credential* an inbound update belongs to, then asks
`tenant` for the value through the Credential Vault. It reads neither unit's
tables directly (§8), and it never logs or returns a token.

The role matters to a caller: C-05 puts OTP and transactional alerts on the
`primary` bot, and exactly one row per `(tenantId, platform)` may hold it.

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

**One unguessable path per bot** (user decision, 2026-09-05; ADR-0009), minted
and rebuilt by this unit. See [contract.webhook.md](contract.webhook.md) for the
addressing rules, the secret-token check (`F-321`) and what a rotation
guarantees (`F-322`).

## Open

See [open-questions.md](open-questions.md). Where verified capability flags live
is blocking for any implementation item.
