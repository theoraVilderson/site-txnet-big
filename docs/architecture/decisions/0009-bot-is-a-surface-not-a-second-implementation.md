---
id: adr-0009
status: accepted
updated: 2026-09-05
---

# ADR 0009 — The bot is a surface over the same services, not a second implementation

- **Status:** accepted
- **Date:** 2026-09-05
- **Affects units:** bot-app, messenger, identity, auth-api, panel-web, tenant, notification

## Context

Two messengers ship with the product: Telegram and Bale. The catalog's
foundational decision `D-02` ("Bot as a Full Panel") and §10.3–§10.4 (16
features: `F-301`, `F-302`, `F-303`–`F-319`, `F-1531`) require that most of what
the user panel can do is also reachable from the bot — registration and login,
catalog and payment, wallet, tickets, and the reseller's own management screens.
The stated reason is operational, not aesthetic: an Iranian reseller works from a
phone, and a management surface that exists only on the web is a surface half
their work never reaches.

Three forces make this hard to reverse once chosen wrong:

1. **Telegram and Bale are not interchangeable.** §10.3 states this as "Bale is
   a subset of Telegram", and code assuming they are identical breaks on Bale in
   production. See the amendment below: the *direction* of that claim turned out
   to be wrong, but the conclusion — one place for the difference — did not.
2. **A bot that owns rules drifts from the panel.** Two surfaces implementing
   "can this user claim a trial" is two answers to one question, and the
   divergence surfaces as a support ticket, not as a failing test.
3. **The bot code that exists today grew inside `auth-service`**
   (`auth/bot-link/`, `auth/otp/senders/`). That was correct for its scope — the
   `F-0203` account-link and OTP delivery are auth concerns — but it is not a
   home for the whole product, and left alone it becomes one by accretion.

## Decision

We will build the bot as **two units and no business logic**.

`platform/messenger` is the only place a messenger difference may appear. It owns
the per-platform driver, a **declared capability set** per platform (`F-301`),
the **degradation policy** that substitutes a lesser affordance instead of
failing (`F-302`), and one renderer per platform. `interfaces/bot-app` owns
conversation state and screens, written once and platform-agnostic: a screen is a
`BotView` — i18n keys, buttons, optional media — never a Telegram payload. The
renderer, not the flow, decides whether that becomes an inline keyboard, a reply
keyboard, or a plain numbered list.

Neither unit may hold a business rule. `bot-app` reaches domains the way
`panel-web` does — through `auth-api` and the service APIs that follow it — so
the bot and the panel are two renderings of one decision, and cannot disagree.

**Chat-first is a rule, not a preference** (user directive, 2026-09-05). Every
§10.4 capability must be completable in a plain chat conversation on both
platforms. The Mini App (`F-310`) is an *enhancement offered on top* of a
working chat flow — never the only path to a capability, and never the reason a
chat flow was not designed. When it is offered it is `panel-web` with a shared
session, so it is still not a third implementation.

## Consequences

- **Positive:** one flow layer, two renderers. A Bale gap becomes a capability
  flag consulted in one place instead of `if (platform === 'bale')` scattered
  through flows. Panel/bot drift is structurally impossible because neither owns
  rules. A third messenger costs a driver, not a product.
- **Negative / accepted cost:** the `BotView` indirection makes a one-line
  message more code than a direct `sendMessage`. Every new panel capability now
  has a second surface to wire even when the wiring is trivial. Degradation must
  be *designed* per capability — `F-302` is a policy, and a policy nobody wrote
  down degrades into a silent failure.
- **What this forecloses:** separate per-platform bot codebases; putting a rule
  "just in the bot because it is faster there"; treating the bot as a
  notification channel with buttons.

## Migration path (not a doc change — real code moves)

- `F-0203` account linking stays owned by `identity` / `auth-api`. It is an auth
  step that happens to arrive over a webhook, and the panel polls it. It does not
  move into `bot-app`.
- `otp/senders/bot-client.registry.ts` and `otp/senders/telegram-like-bot.client.ts`
  are the seed of `messenger` and currently sit under `identity`'s `source:`
  globs. They move on the first `messenger` implementation item, not before —
  until then `messenger` stays `status: draft` with `source: []`.
- **Addressing is per bot, not per platform** (user decision, 2026-09-05): one
  unguessable webhook path per `TenantBotIntegration`, which is what
  `webhookPath @unique` already models. The live `F-0203` route
  (`POST /auth/bots/:platform/webhook/:secret`) is already per-secret, so it is
  the same shape and does not have to break — it converges on the per-bot path
  rather than being replaced. One bot's failure cannot reach another's.


## Amendment, 2026-09-05 — the divergence is shape, not subset

Bale's own documentation ([docs.bale.ai](https://docs.bale.ai/),
[docs.bale.ai/miniapp](https://docs.bale.ai/miniapp), read 2026-09-05) does not
support the catalog's "subset" framing. Both platforms have inline **and** reply
keyboards, the same file ceilings (10/5 MB photo, 50 MB document, 20 MB
download), a Mini App, and — decisively — the *same* HMAC-SHA-256 init-data
scheme, so `F-310`'s shared session works on both. Bale additionally has methods
Telegram does not (`askReview`, `showScanQrPopup`, `addToHomeScreen`, a
higher-rate-limit business path).

Every real divergence is a difference of **shape**: a different API base URL
(`tapi.bale.ai`), a different global (`window.Bale.WebApp`), a different deep
link (`ble.ir/<bot>?startapp` vs `t.me/<bot>?start=`), and genuinely different
payment rails (Bale's own wallet: `sendInvoice` / `answerPreCheckoutQuery` /
`inquireTransaction`).

**This does not reverse the decision — it re-aims it.** Two units and one flow
layer are still right, and are now *cheaper* than assumed. What changes is where
the work is:

- The `F-301` capability set is smaller than the catalog implies. Only payments
  is a true presence-difference. Do not build elaborate flag machinery for axes
  the docs show as identical.
- The `F-302` degradation policy has, today, almost nothing to degrade. It stays
  — a platform can remove something, and an unverified assumption is what this
  amendment exists to prevent — but it is not the first thing to build.
- **The real risk moved to shape adapters**: deep-link encoding (`F-314`, and the
  `F-0203` token already in production is Telegram-shaped), base URL, global
  name, and the payment rails. A hard-coded `t.me/` or `window.Telegram`
  anywhere above `messenger` is the failure this unit exists to prevent.

The verified table, with dates, is in `platform/messenger/contract.md`. The
catalog is not edited: §10.3 is the product's stated intent, and this ADR is the
`architecture/decisions/` record of what the API actually does (§0 authority
order — running code and vendor IDL outrank intent).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| A `telegram-bot` service and a `bale-bot` service | duplicates every flow in §10.4; `F-302` cannot be honoured centrally, so each service degrades differently |
| One bot service that also owns its rules | the drift in Context #2; also breaks §8 — a surface reaching into domain internals |
| Bot as a notification channel; Mini App for everything else | Rejected by the chat-first rule above. Bale *does* have a WebApp surface, so this was technically open — but a product reachable only by opening a web view excludes every user who will not, and §10.4's stated motive (a reseller working from a phone, in a chat) is exactly that user |
| Keep growing it inside `auth-service` | Context #3: auth-service becomes the whole product and the auth slice's boundary stops meaning anything |
| One renderer, lowest common denominator for both | throws away Telegram affordances the catalog explicitly buys (`F-310`, `F-308`, payments) for every user, to spare one `if` |

## Revisit trigger

Either of:

- Bale's payment rails converge with Telegram's, or we stop supporting in-chat
  payment on one of them. Payments is the last true presence-difference; without
  it `messenger` is a naming adapter and the capability set is dead weight.
- A third channel arrives whose interaction model is not chat-shaped (voice, a
  native app). `BotView` is a chat abstraction and should not be stretched to
  cover one.
