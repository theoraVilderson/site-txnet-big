---
id: panel-web
layer: interface
status: active
version: 13
keywords: [panel, site-pwa, user panel, register, signup, captcha, bot check, forgot password, otp channel picker, bot link, telegram link, bale link, account switcher, switch account, multi account, add account, panel session, mini app, miniapp, webapp, panel inside telegram, panel inside bale, مینی اپ, پنل داخل تلگرام, پنل داخل بله, phone field, country picker, country code, dial code, فیلد شماره, انتخاب کشور, کد کشور, error message, form error, خطا نمایش داده نمیشه, ارور نشون نمیده, پیام خطا, خطا به زبان اشتباه, نمایش خطا, default language, زبان پیشفرض, سایت انگلیسی میاد, زبان اشتباه, به جای فارسی انگلیسی, DEFAULT_LANGUAGE, websocket, socket, realtime, live updates, push, reconnect, subscribe, channel, socket client, sidebar, side menu, dashboard shell, dashboard layout, mobile drawer, hamburger menu, collapse sidebar, top bar, سایدبار, منوی کناری, منوی موبایل, داشبورد پنل, ui kit, pagination, skeleton, date picker, jalali calendar, amount in words, money format, صفحه بندی, تقویم شمسی, مبلغ به حروف, wallet, wallet button, balance, top bar balance, quick actions, top up, gift code, کیف پول, موجودی, دکمه کیف پول, موجودی بالای صفحه, عملیات سریع, شارژ حساب, کد هدیه]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n, realtime]
updated: 2026-09-12
---

# panel-web

**Responsibility (one sentence):** the Next.js user panel (`site-pwa`) served at
`panel.<domain>` — auth screens (login / register / OTP / forgot-password),
locale + theme handling, and a thin server-side proxy to the backend API.
**Explicitly NOT responsible for:** any business rule, auth decisions (delegated
to `auth-api`), translation content (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.errors.md](contract.errors.md) | a failed call is not reaching the user, or reaches them in the wrong language |
| [contract.md](contract.md) | changing routes / the API proxy / i18n endpoints |
| [contract.realtime.md](contract.realtime.md) | the panel opens, holds or loses a WebSocket (F-070-a), an auth screen waits on an OTP delivery (F-070-b), or a signed-in screen wants live updates (F-070-c) |
| [contract.mini-app.md](contract.mini-app.md) | the panel is running inside Telegram or Bale (F-310) |
| [contract.shell.md](contract.shell.md) | a panel page gets a menu entry, a top-bar control is added, or the sidebar / mobile drawer misbehaves (F-093-a) |
| [contract.kit.md](contract.kit.md) | a money page formats an amount, spells it, pages a table, picks a date or shows a skeleton (F-093-b) |
| [contract.session-guard.md](contract.session-guard.md) | a signed-in visitor is not redirected off an auth screen (F-0101) |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-12 | v12 -> **v13** (F-093-c): the top bar shows the wallet balance, and this app calls a second backend. `lib/billing-api.ts` reads `billing`'s `wallet/history` cross-origin at `api.<domain>`, the way `auth-api` is already reached — `billing-service` had shipped with CORS off and a comment asserting a panel proxy this app had deleted a week earlier, and F-093-c is the first caller that could find it. The envelope both clients read moved to `lib/api-request.ts`; `request()` kept its signature, so none of its 24 call sites changed. The balance is never computed here: an event on `user:<userId>` makes it re-read, and the payload is not parsed, so `F-092-j` can publish any shape. [contract.shell.md](contract.shell.md) |
| 2026-09-10 | v11 -> **v12** (F-070-c): the signed-in panel holds one socket for the whole session. `(panel)/_context/PanelRealtimeContext.tsx` opens it *after* `PanelSessionContext` has a token — an earlier one would be anonymous and refused every `user:` channel in silence — keys it to the current account so a switch is a close-and-reopen, and routes `4401` into the login redirect. No producer yet; `F-034` is the first. [contract.realtime.md](contract.realtime.md) |
| 2026-09-10 | v10 -> **v11** (F-070-b): the auth screens hear what became of the code. `_hooks/useOtpDelivery.ts` subscribes the `otp:` channel a 202 handed over and reads `otp/delivery/status` once beside it — the push is the fast path, the status route is the record (D-15). Only an end state replaces what is held, and `queued` renders as *not yet*, never as *no such number*. [contract.realtime.md](contract.realtime.md) |
| 2026-09-10 | v9 -> **v10** (F-070-a): the panel has a WebSocket client. `lib/realtime.ts` is the only place a socket is opened — reconnect with backoff, a client-side heartbeat, the subscription cap counted locally, declare-and-re-authorize resume, and `4401` routed to sign-out rather than to a reconnect. Transport only: no screen uses it yet. [contract.realtime.md](contract.realtime.md) |
| 2026-09-10 | v8 -> **v9** (fix, F-068): the deployment decides what language a stranger is answered in. `getUserLocale` consulted `Accept-Language` *before* the default, so an English browser opened a Persian deployment in English on the first request; that step is gone and `DEFAULT_LOCALE` now reads `DEFAULT_LANGUAGE` from the environment instead of being the literal `"fa"`. Precedence is saved account language -> `NEXT_LOCALE` cookie -> `DEFAULT_LANGUAGE`, matching `bot-app` (F-046, ADR-0016) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
