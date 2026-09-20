---
id: panel-web
layer: interface
status: active
version: 6
updated: 2026-09-20
---

# panel-web — the same panel, inside a messenger

How this app behaves when a messenger opened it (F-310, ADR-0017). Split out of
[contract.md](contract.md) at 250 lines (§10): it is one self-contained
behaviour with one entry point, and every other section of the contract is read
without it.

There is no Mini App build, route or layout. The Mini App **is** this app, and
the entire per-platform surface is `lib/mini-app.ts`: it answers whether a
messenger opened this page and, if so, hands back the `initData` that messenger
signed. Telegram and Bale differ by the name of one global
(`window.Telegram.WebApp` / `window.Bale.WebApp`) and by the URL of one script,
and by nothing else.

**Neither global exists until the page loads that platform's own script**, and
that is what broke this feature between 2026-09-08 and 2026-09-10: the panel
read the global, loaded no script, found nothing, and sent every Mini App
visitor to the login screen — silently, because "no host" is a legitimate
answer with a legitimate screen behind it. A page cannot tell which script to
load from inside a webview, so the bot marks the URL it hands over:
`?ma=telegram` / `?ma=bale` (`MINI_APP_PARAM`,
[bot-app/contract.md](../bot-app/contract.md)). The two SDK URLs, dated and
read from each platform's own documentation, are in
[messenger/contract.md](../../platform/messenger/contract.md).

Three things follow, and each is deliberate:

- **An ordinary browser loads nothing.** No marker, no script, no third-party
  request on any normal panel visit — which matters here, where
  `telegram.org` is filtered and a blocking `<head>` script would cost every
  visitor their first paint.
- **The load is on the failure path only**, after the refresh cookie is gone,
  so a webview that is already signed in never fetches an SDK either.
- **A script that never arrives is `null`, not a hang.** Blocked, filtered or
  simply down all resolve to "this page cannot prove who is looking", which is
  the ordinary login screen — the same answer as no host at all. The marker is
  a hint about which script to fetch and **never** a credential; the server
  verifies the signature itself, so forging `?ma=` picks the wrong script and
  buys nothing.

`PanelSessionProvider` asks it **only after the refresh cookie has failed**. A
webview starts with an empty cookie jar, so that failure is not evidence of
anything there — the host is holding a signature that says who is looking, and
`authApi.webAppSession(platform, initData)` trades it for the ordinary session:
the same cookie, the same in-memory access token, the same `listAccounts()`
afterwards. Nothing past that call knows the panel is in a webview, and a
webview that is already signed in pays nothing for the feature.

Two answers are one answer. A verification failure and `state:"needsContact"`
(this messenger account has never shared its card with the bot) both fall
through to `AUTH_LOGIN` — the ordinary login screen, rendered inside the
webview, not a Mini-App-specific dead end. Closing the `needsContact` gap needs
a contact card, and the keyboard that asks for one exists only in a chat.

`initData` is passed **verbatim**: the signature covers the exact string, so a
client that re-encodes or reorders it produces a valid-looking string that
verifies as forged.

## The switcher inside the Mini App (ADR-0032)

The session `webAppSession` returns is minted under the **chat's** switch scope,
not this webview's `device_id`. So `listAccounts()` here lists the group the
user built in the bot, `addAccount*` adds to that group, and `switchAccount`
moves inside it. Nothing in this app does anything to make that true — the
scope rides on the session — but it is the reason the switcher inside the Mini
App is not empty for someone who has only ever used the bot.

The user's own browser is still a separate group, and that is intended: the
Mini App is the chat, and a laptop is not.

## Paying inside the Mini App (F-104-o)

`openMiniAppInvoice(link)` is the second and last thing this file does for a
page. It opens the invoice link `POST /deposit/start` answered in the
messenger's own payment sheet — `WebApp.openInvoice(url, callback)`, the same
call on Telegram and Bale (Bale checked 2026-09-16) — and resolves with how the
sheet closed: `paid`, `pending`, `cancelled`, `failed` (any status it does not
know), or `unavailable` (no marker, the SDK never arrived, no `openInvoice`, or
it threw). It loads the SDK itself when the session came from a cookie and never
needed one, and it needs no `initData`: the link is already this payment's.

**A sheet that closed without paying is reported (F-093-q).** `start` has
already written the payment and held a slot of every coupon applied to it by
the time the sheet opens, so until that row closes a one-use code answers
`per_user_limit_reached` — and the retry the payer makes a second later is
refused for a payment the messenger never charged. On `cancelled`, `failed` and
`unavailable` alike the page therefore calls `POST /deposit/:paymentId/abandon`
and gives those holds back at once. Nothing waits on the answer and a failure
is swallowed: it costs only the wait it would have saved, and billing refuses
the call itself for a payment pre-checkout has already approved, where the
messenger may hold the money (`billing/contract.webhook.md`).

**The marker outlives its URL.** `?ma=` is on the URL the bot handed over and
on no other — a client-side navigation drops it, and the top-up page is never
that URL. So `miniAppPlatform()` keeps a marker it reads in `sessionStorage`
(`txnet.miniApp`) and falls back to it. One tab is the webview; an ordinary
browser that never carried the marker still loads nothing, and storage that is
blocked leaves the URL as the only source. It stays a hint, never a credential.

Proof: `lib/mini-app.test.ts`.
