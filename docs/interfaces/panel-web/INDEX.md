---
id: panel-web
layer: interface
status: active
version: 8
keywords: [panel, site-pwa, user panel, register, signup, captcha, bot check, forgot password, otp channel picker, bot link, telegram link, bale link, account switcher, switch account, multi account, add account, panel session, mini app, miniapp, webapp, panel inside telegram, panel inside bale, مینی اپ, پنل داخل تلگرام, پنل داخل بله, phone field, country picker, country code, dial code, فیلد شماره, انتخاب کشور, کد کشور, error message, form error, خطا نمایش داده نمیشه, ارور نشون نمیده, پیام خطا, خطا به زبان اشتباه, نمایش خطا]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n]
updated: 2026-09-09
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
| [contract.mini-app.md](contract.mini-app.md) | the panel is running inside Telegram or Bale (F-310) |
| [contract.session-guard.md](contract.session-guard.md) | a signed-in visitor is not redirected off an auth screen (F-0101) |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-09 | v7 -> **v8** (fix, F-066-r): the auth-screen guard names the tenant it belongs to — `X-Forwarded-Host` = the host of `NEXT_PUBLIC_API_ORIGIN` — on the internal hop only. Without it the host auth-service saw was the container name, which resolved to no tenant once F-066-d removed the fallback, so a signed-in visitor stayed on the login form. The guard's rule moved to `contract.session-guard.md` (§10, 250 lines) |
| 2026-09-08 | Contract v6 -> **v7** (F-053): a failed call is shown, in the panel's own language. `ApiError` is the one failure shape, `<FormError>` the one place an auth screen says so, and the panel sends its `lang` as `Accept-Language` — `auth-api` was translating errors from the *browser's* header |
| 2026-09-08 | Contract v5 -> **v6** (F-310, ADR-0017): the panel runs as a Mini App inside Telegram and Bale. `lib/mini-app.ts` is the whole per-platform surface; `PanelSessionProvider` trades the host's signed `initData` for the ordinary session, but only after the refresh cookie has failed. A refusal — forged, or a messenger account that never shared its contact — lands on the ordinary login screen |
| 2026-09-07 | Contract v4 -> **v5** (F-015): the account-creation screen is `/auth/register`, not `/auth/signup` — the name `auth-api`, the bot and coinsite already used. Route, component, `auth` locale keys (`register.*`, `messages.success.register`) and the `AuthFooterLinks` variant all move together; `src/proxy.ts` 308s the old path (suffix + query kept) so links already sent still land. Paths now come from `AUTH_LOGIN` / `AUTH_REGISTER` in `lib/routes.ts` |
| 2026-09-06 | Contract v3 -> **v4** (ADR-0015): the switcher's group is scoped to this browser via a server-minted httpOnly `device_id` cookie, and gains a remove control (F-0208). `credentials: "include"` is now load-bearing — it is how the scope reaches the server |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
