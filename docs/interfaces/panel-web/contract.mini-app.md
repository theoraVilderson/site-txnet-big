---
id: panel-web
layer: interface
status: active
version: 6
updated: 2026-09-08
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
(`window.Telegram.WebApp` / `window.Bale.WebApp`) and by nothing else.

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
