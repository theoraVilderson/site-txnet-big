---
id: surfaces
status: active
updated: 2026-09-05
code_roots:
  - site-pwa/src
  - coinsite/src
  - txnet-backend/auth-service/src
  - auth-handler/internal
  - i18n-platform/services/locale-service
---

# Surface map — what the user can point at

`MASTER_INDEX.md` answers *"which unit owns this concern?"*. This file answers
the question a user actually asks: **"the register form on the landing site is
broken"** — a thing they can see, named in their own words, with no path
attached.

One row per user-visible surface: a screen, a tab, a button, a form, a bot
command, a public endpoint. Resolve a row with:

```bash
python3 tools/where.py "the register form on the landing site"
```

Never make the user say a path. If they had to, this file is missing a row.

## Rules

- `surface` — kebab-case, permanent, unique. It is an **id**, not a label.
- `aliases` — comma-separated, in the words a person actually types, including
  the sloppy short forms. This column is the whole point of the file; a row
  without aliases will never be found by a human's own phrasing. **Add an alias
  the moment a query misses.** Persian phrasing goes here too — `tools/where.py`
  normalises Persian/Arabic script.
- `unit` — must exist in `MASTER_INDEX.md`. A surface with no owning unit is a
  BLOCKING question (`00-PROTOCOL.md` §9), not a row to invent.
- `component` — a real path or glob, checked by `python3 tools/where.py --check`.
  This is the **only** place a UI path is written down.
- `spec ref` — the catalog id, never a line range. `—` if the surface predates
  the catalog.
- One surface = one thing a person can point a finger at. A page with six
  independent controls is one row for the page **plus** a row for each control
  that gets edited on its own.
- Never delete a row. A removed surface keeps its id and gets `(removed)` in the
  note, for the same reason a catalog id is never deleted.

## Panel (site-pwa)

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| panel-auth-proxy | auth proxy, login proxy, api auth proxy, register proxy, signup proxy |  | panel-web |  | — | (removed) 2026-09-05 — replaced by panel-auth-direct; browser calls auth-service cross-origin now instead of via a same-origin Next.js hop |
| panel-auth-direct | refresh token cookie, refresh_token cookie, کوکی رفرش توکن, کوکی ست نمیشه, مستقیم به api, direct api call, api.txnet.cyou مستقیم | `${NEXT_PUBLIC_API_ORIGIN}/api/auth/*` | panel-web | site-pwa/src/lib/auth-api.ts | — | browser -> auth-service direct, cross-origin, `credentials:"include"`; cookie lands via auth-api's CORS (`FRONTEND_ORIGIN` + `credentials:true`), not a proxy rewrite; see panel-web/contract.md TL;DR for the latency tradeoff this accepts |
| panel-i18n-route | i18n route, translations endpoint | /api/i18n/[lang]/[ns] | panel-web | site-pwa/src/app/api/i18n | — | |
| panel-auth-screens | login screen, auth screens, login page | /(auth)/auth | panel-web | site-pwa/src/app/(auth)/auth | — | |
| panel-nav | panel nav, top bar, header of the panel, نوار بالای پنل, nav پنل, هدر پنل | / | panel-web | site-pwa/src/app/(panel)/_components/PanelNav.tsx | — | the signed-in counterpart of `AuthNav`; lives in the `(panel)` route group layout, so every future panel page gets it |
| panel-logout-button | logout, log out, sign out, دکمه لاگ اوت, خروج از حساب, لاگ اوت | / | panel-web | site-pwa/src/app/(panel)/_components/LogoutButton.tsx | — | POSTs `/auth/logout` (the refresh cookie is the credential, so it works after a reload with no access token in memory) then `router.replace` to the login screen; a failed call still leaves — the device is signed out either way |
| panel-forgot-password | forgot password, forgot password page, reset password screen, فراموشی رمز, رمزمو فراموش کردم, بازیابی رمز عبور, صفحه فراموشی رمز | /(auth)/auth/forgot-password | panel-web | site-pwa/src/app/(auth)/auth/forgot-password/page.tsx | F-0204 | four steps: phone + delivery method -> (connect messenger, if needed) -> code -> new password. On success the device is signed in and lands on `PANEL_HOME`; every other device is signed out |
| panel-otp-channel-picker | otp channel picker, delivery method, how to receive the code, choose sms or telegram, انتخاب روش ارسال کد, کد رو با تلگرام بفرست, انتخاب پیامک یا تلگرام یا بله | (embedded in login + forgot-password) | panel-web | site-pwa/src/app/(auth)/auth/_components/OtpChannelPicker.tsx | F-0202 | renders only the channels `GET /auth/otp/channels` returns (`_hooks/useOtpChannels.ts`); hidden when there is only one |
| panel-bot-link-step | connect telegram, connect bale, share contact with bot, open bot link, اتصال تلگرام, اتصال بله, ارسال مخاطب به ربات, لینک ربات باز نمیشه | (step in login + forgot-password) | panel-web | site-pwa/src/app/(auth)/auth/_components/BotLinkStep.tsx | F-0203 | shows the `?start=` deep link and polls `POST /auth/bots/link/status` every 2.5s (`_hooks/useBotLink.ts`); the code is sent by the bot, not by this screen |
| panel-auth-session-redirect | redirect if already logged in, token valid redirect, اگه توکن کاربر valid بود ریدارکت بشه, ریدارکت به panel.txnet.cyou, بعد از لاگین کجا بره, نره به /dashboard, سر روت پنل, panel root redirect, login page while signed in, ریدارکت سریع, تشخیص سریع لاگین, refresh token نامعتبر پاک بشه, clear invalid refresh token, next.js proxy redirect, middleware redirect | (server-side, on /auth/login and /auth/signup) | panel-web | site-pwa/src/proxy.ts | F-0101 | runs in the Next 16 proxy (middleware), before the screen renders: no `refresh_token` cookie -> straight through, no request; cookie -> `POST /api/auth/refresh` server-to-server at `AUTH_SERVICE_ORIGIN`, `ok:true` -> 307 to `PANEL_HOME`, anything else -> the form. auth-service's `Set-Cookie` is forwarded verbatim, so the rotated token lands on success and the dead one is cleared on failure. Every failure (unreachable, timeout, bad body) ends at the form. `PANEL_HOME` is `/` in `site-pwa/src/lib/routes.ts`, relative so white-label tenants keep their own host. Replaced the old `/dashboard` push, a route this app never had. `forgot-password` is intentionally not guarded |
| panel-captcha-widget | captcha, slide captcha, human verification, bot check, کپچا, تایید ربات, اسلایدر کپچا | (embedded in login/signup/forgot-password) | panel-web | site-pwa/src/app/(auth)/auth/_components/NatureCaptchaUI.tsx | F-0201 | driven by `_hooks/useCaptcha.ts` |
| panel-password-field | password field, password label, floating label, autocomplete پسورد, پسورد لیبل بالا نمیره, اتوکامپلیت پسورد لیبل بالا نمیره | (embedded in login/signup/forgot-password) | panel-web | site-pwa/src/app/(auth)/auth/_components/PasswordField.tsx | — | label float relied on React `value` state; browser/password-manager autofill doesn't fire onChange, so label stayed down until a manual click — fixed 2026-09-05 via `:-webkit-autofill` CSS-animation detection |

## Marketing (coinsite)

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| marketing-login | landing login, login page on landing site | /(Auth)/login | marketing-web | coinsite/src/app/(Auth)/login | — | |
| marketing-register | landing register, signup page on landing site | /(Auth)/register | marketing-web | coinsite/src/app/(Auth)/register | — | |

## API

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| auth-api-register | register endpoint | POST /auth/register | auth-api | txnet-backend/auth-service/src/app/auth | — | |
| auth-api-login | login endpoint, password login | POST /auth/login/password | auth-api | txnet-backend/auth-service/src/app/auth | — | |
| auth-api-impersonate | impersonation, impersonate user | POST /admin/users/:userId/impersonate | auth-api | txnet-backend/auth-service/src/app/impersonation | — | |
| auth-api-captcha | captcha endpoint, human verification api, bot check api, کپچا, تایید ربات | POST /auth/captcha/challenge, POST /auth/captcha/verify | auth-api | txnet-backend/auth-service/src/app/auth/captcha | F-0201 | required (`X-Captcha-Token`) on register/login/forgot |
| auth-api-otp-channels | otp channels endpoint, available delivery methods, which otp channels are on, اندپوینت کانال های otp, روش های ارسال کد | GET /auth/otp/channels | auth-api | txnet-backend/auth-service/src/app/auth/otp/otp-channels.service.ts | F-0202 | env-driven (`OTP_ALLOWED_CHANNELS` + configured senders) |
| auth-api-bot-link-status | bot link status, is the messenger linked yet, وضعیت اتصال ربات | POST /auth/bots/link/status | auth-api | txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts | F-0203 | polled by `panel-bot-link-step` |
| auth-api-no-active-session-guard | block relogin with valid token, prevent signup while logged in, گارد جلوگیری از لاگین دوباره, توکن معتبر نتونه دوباره لاگین کنه, نتونه دوباره ثبت‌نام کنه | POST /auth/register, /auth/login/password, /auth/login/otp/request, /auth/login/otp/verify | auth-api | txnet-backend/auth-service/src/app/auth/guards/no-active-session.guard.ts | F-0101 | 409 `auth.alreadyAuthenticated` if Bearer token verifies to a live session; logout clears it; backend only, no panel-web UI yet |
| forward-auth-rbac-policy | rbac, permissions file, policy file, role permissions, permission denied by the gateway, 403 from traefik, نقش دسترسی نداره, فایل پرمیشن, موتور نقش‌ها, engine.go, policy.go | POST /validate (Traefik ForwardAuth) | forward-auth | auth-handler/internal/auth | — | the `roles: -> <role>: -> permissions:` indent format in `configs/permissions.yaml` (`PERMISSIONS_FILE_PATH`), parsed at boot by `LoadFile` and enforced per request by `Engine.Check`. A malformed file is a hard boot error, never a partial policy |

## Bot / other

| surface | aliases | route | unit | component | spec ref | note |
|---|---|---|---|---|---|---|
| bot-link-webhook | telegram webhook, bale webhook, bot webhook, ربات جواب نمیده, وبهوک تلگرام, وبهوک بله, ربات مخاطب رو قبول نمیکنه | POST /auth/bots/:platform/webhook/:secret | auth-api | txnet-backend/auth-service/src/app/auth/bot-link/bot-link.controller.ts | F-0203 | the bot's `/start <token>` + shared-contact conversation. Wrong/absent secret -> 404. Handling is best-effort and always answers 200, so the platform never redelivers |
| bot-otp-delivery | otp in telegram, code in bale, ربات کد نمیفرسته, کد تو تلگرام نمیاد | (outgoing sendMessage) | identity | txnet-backend/auth-service/src/app/auth/otp/senders/ | F-0202 | only delivers to a `linked_bot_account` with `contactVerifiedAt` set |

## Flows

A surface is a thing you point at. A flow is a **behaviour that crosses units**:
a cookie login touches `panel-web`, `auth-api` and `redis-keyspace`.
`python3 tools/where.py --walk "<sentence>"` derives that chain from
`depends_on` plus the runtime edges in
`architecture/dependency-graph.md` every time it is asked. This table is the
cache.

**Never write a flow row in advance.** A row written before the walk is a guess
at which files matter, and it is wrong in the most expensive way — it looks like
knowledge. Rows are written **after** a fix, from the path actually taken, by
MODE: DIAGNOSE (`00-PROTOCOL.md` §6g) step 7. The second time the same thing is
reported, there is no walk at all.

- `flow` — kebab-case, permanent, unique. An id, like a surface.
- `aliases` — **the user's own sentence, verbatim**, symptom words included,
  Persian phrasing included. That is the row's whole value.
- `path` — the unit chain, `->` separated, in the order the walk took it. Every
  id must exist; `where.py --check` fails otherwise.
- `files` — only the files the fix actually touched, not the files that were
  read. A flow row is evidence, not a reading list.
- Never delete a row. A flow that stops existing keeps its id and gets
  `(removed)` in the note.

| flow | aliases | path | files | spec ref | note |
|---|---|---|---|---|---|
| forgot-password-otp | forgot password, forgot password with otp, رمزمو فراموش کردم, بازیابی رمز با کد, otp برای فراموشی رمز, کد بازیابی نمیاد, بله رو انتخاب کردم ارور داد, Something went wrong روی password/forgot | panel-web -> auth-api -> identity -> redis-keyspace | site-pwa/src/app/(auth)/auth/forgot-password/page.tsx, txnet-backend/auth-service/src/app/auth/auth.service.ts, txnet-backend/auth-service/src/app/auth/otp/otp.service.ts | F-0204 | `password/forgot` -> `password/forgot/verify-otp` -> `password/reset`. Redis holds the code; the reset revokes every session then issues one for this device. A generic `{ok:false,ref}` here is never the channel — take the `ref` to the auth-service log, the real cause is above it (2026-09-05: dev DB behind `identity.prisma`, `BotLinkService.hasVerifiedLink` querying a column `db push` had never created) |
| otp-channel-choice | choose how to get the code, turn off sms, only telegram and bale, پیامک رو خاموش کن, فقط تلگرام و بله, انتخاب کانال otp | panel-web -> auth-api -> identity | site-pwa/src/app/(auth)/auth/_hooks/useOtpChannels.ts, txnet-backend/auth-service/src/app/auth/otp/otp-channels.service.ts, txnet-backend/auth-service/src/app/config/env.validation.ts | F-0202 | the switch is `OTP_ALLOWED_CHANNELS` in `.env` (+ the bot token / SMS credentials being present) |
| captcha-verified-state | captcha reset, captcha انگار درست reset نمیشه, میرم صفحه بعدی میام قبلی فلش میاد از اول ولی هنوز رو حال verified هستش, اسلایدر کپچا از اول میاد, کپچا هر ۲ دقیقه ریستارت میشه, اول slide میکشم میپره عقب باید یکم صبر کنم بعدش بکشم اوکی میشه, اولین بار اسلایدر کار نمیکنه, اطلاعات جدید زده شده بعد اینکه کپچا حل شده بود و درخواست otp رفته بود اگه کاربر اطلاعات قبلی رو عوض کرد کپچا باید جدید شه | panel-web -> auth-api -> redis-keyspace | site-pwa/src/app/(auth)/auth/_components/NatureCaptchaUI.tsx, site-pwa/src/app/(auth)/auth/_hooks/useCaptcha.ts, site-pwa/src/app/(auth)/auth/login/page.tsx, site-pwa/src/app/(auth)/auth/signup/page.tsx, site-pwa/src/app/(auth)/auth/forgot-password/page.tsx | F-0201 | the pass lives in `useCaptcha` (parent), the thumb position in `NatureCaptchaUI` (child). A multi-step form unmounts the child, so its slider must be seeded from `isVerified`. The 120s re-arm is by design — `RedisTtl.captchaVerified`. Two more failure shapes, both in `useCaptcha`: the challenge is fetched on mount, so a slide that lands before the id does used to return early and snap the thumb back (`complete` now awaits the in-flight request); and the pass is single-use server-side, so every caller must `spend()` it after handing it to an endpoint or a user who goes back and edits step 1 re-submits a burnt token |
| bot-link-webhook | open the bot, waiting for you to confirm in the messenger, بات رو باز میکنم هیچی نمیاد, اینجا وایمیسته ولی لینکو که باز میکنم هیچی نمیادش, لینک بات باز میشه ولی کد نمیاد, ربات جواب نمیده, share your number with the bot but nothing happens | panel-web -> auth-api -> messenger | txnet-backend/auth-service/src/app/auth/bot-link/bot-webhook.registrar.ts, txnet-backend/auth-service/src/app/auth/otp/senders/telegram-like-bot.client.ts, txnet-backend/auth-service/src/app/auth/otp/senders/bot-client.registry.ts, scripts/set-bot-webhook.sh | F-0202 | the panel only polls `bots/link/status`; everything else happens in the messenger. If the deep link opens the bot and the bot then says nothing, the bot has no webhook — `getWebhookInfo` is the one command that decides it. auth-service now registers its own webhook on boot (`BotWebhookRegistrar`); `scripts/set-bot-webhook.sh dev` does it by hand. Two separate reachability problems: outgoing calls to api.telegram.org need `TELEGRAM_API_BASE` (proxy), and Telegram's incoming calls time out against this server, so `TELEGRAM_WEBHOOK_PUBLIC_BASE` sends them back through the same proxy. `last_error_message` in `getWebhookInfo` is where that shows up |
| bot-account-link | connect telegram to account, share contact with the bot, verify contact belongs to sender, اتصال حساب به ربات, ارسال مخاطب, تایید مالکیت شماره در تلگرام | panel-web -> auth-api -> identity -> redis-keyspace | txnet-backend/auth-service/src/app/auth/bot-link/bot-link.service.ts, txnet-backend/auth-service/src/app/auth/bot-link/bot-link.store.ts, site-pwa/src/app/(auth)/auth/_components/BotLinkStep.tsx | F-0203 | the ownership check is `contact.user_id === message.from.id` plus a phone match; both live in `BotLinkService.handleContact` |
