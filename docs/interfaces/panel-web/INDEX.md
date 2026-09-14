---
id: panel-web
layer: interface
status: active
version: 18
keywords: [panel, site-pwa, user panel, register, signup, captcha, bot check, forgot password, otp channel picker, bot link, telegram link, bale link, account switcher, switch account, multi account, add account, panel session, mini app, miniapp, webapp, panel inside telegram, panel inside bale, مینی اپ, پنل داخل تلگرام, پنل داخل بله, phone field, country picker, country code, dial code, فیلد شماره, انتخاب کشور, کد کشور, error message, form error, خطا نمایش داده نمیشه, ارور نشون نمیده, پیام خطا, خطا به زبان اشتباه, نمایش خطا, default language, زبان پیشفرض, سایت انگلیسی میاد, زبان اشتباه, به جای فارسی انگلیسی, DEFAULT_LANGUAGE, websocket, socket, realtime, live updates, push, reconnect, subscribe, channel, socket client, sidebar, side menu, dashboard shell, dashboard layout, mobile drawer, hamburger menu, collapse sidebar, top bar, سایدبار, منوی کناری, منوی موبایل, داشبورد پنل, ui kit, pagination, skeleton, date picker, jalali calendar, amount in words, money format, صفحه بندی, تقویم شمسی, مبلغ به حروف, wallet, wallet button, balance, top bar balance, quick actions, top up, gift code, کیف پول, موجودی, دکمه کیف پول, موجودی بالای صفحه, عملیات سریع, شارژ حساب, کد هدیه, gift modal, redeem a gift code, gift code box, وارد کردن کد هدیه, کد هدیه کجاست, top up page, top-up page, deposit page, charge wallet, add funds, amount in words on the top-up page, discount code on top-up, gateway picker, payment gateway list, صفحه شارژ, شارژ کیف پول, افزایش موجودی, واریز, انتخاب درگاه, کد تخفیف شارژ, مبلغ شارژ, financial page, financial history, transactions page, transaction list, payment history, my payments, top-up attempts, expandable row, advanced filter, date range filter, صفحه امور مالی, تاریخچه مالی, لیست تراکنش ها, گردش حساب, تراکنش هام کجاست, صفحه تراکنش ها, پرداخت های من, فیلتر پیشرفته, فیلتر تاریخ, جزئیات تراکنش, payment result, payment success page, payment failed page, back from the bank, returned from the gateway, reference number, tracking code, صفحه نتیجه پرداخت, پرداخت موفق, پرداخت ناموفق, بازگشت از بانک, کد رهگیری, gateway management, payment gateways page, merchant id, link gateway to tenant, مدیریت درگاه پرداخت, تنظیم درگاه, حذف درگاه, لینک درگاه, coupons page, discount coupons, gift codes, gift code batch, کوپن تخفیف, کد هدیه, مدیریت کوپن, catalog page, product catalog, variants, sku, price history, new price, کاتالوگ, مدیریت محصولات, قیمت محصول, تاریخچه قیمت]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n, realtime]
updated: 2026-09-14
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
| [contract.shell.md](contract.shell.md) | a panel page gets a menu entry, a top-bar control is added, a wallet quick action opens something (F-093-g), or the sidebar / mobile drawer misbehaves (F-093-a) |
| [contract.kit.md](contract.kit.md) | a money page formats an amount, spells it, pages a table, picks a date, shows a skeleton or prints a timestamp (F-093-b) |
| [contract.deposit.md](contract.deposit.md) | the top-up page — its amount box, discount codes, gateway picker or bill, or a figure on it that looks wrong (F-093-e) |
| [contract.manual-payments.md](contract.manual-payments.md) | a person confirms a payment the gateway would not — the list, inquire-then-confirm, or an outcome that reads wrong (F-093-n) |
| [contract.coupons.md](contract.coupons.md) | the coupons page — the discount list, the coupon form, gift-code batches, a usage report, or a refusal that reads wrong (F-502-g/h) |
| [contract.catalog.md](contract.catalog.md) | the catalog page — categories, products, variants, a new price or price history, or a refusal that reads wrong (F-026-f) |
| [contract.payment-result.md](contract.payment-result.md) | a bank returns a payer to `/payment/success` or `/payment/failed` — a reference, an "already paid", or an error code that reads wrong (F-093-f) |
| [contract.financial.md](contract.financial.md) | the financial page's two lists, its filters, or a date range that returns the wrong day (F-093-d) |
| [contract.session-guard.md](contract.session-guard.md) | a signed-in visitor is not redirected off an auth screen (F-0101) |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-12 | v17 -> **v18** (F-093-i, ADR-0042): a deep link survives an expired session. The panel guard remembers the path it bounced from and the three sign-in screens return to it — in `sessionStorage`, never in a query parameter, and only ever a **relative path**, validated on the way in and on the way out, because an open `returnTo` on a sign-in screen is the classic phishing vector. Reading consumes it; a deliberate sign-out clears it. One module (`lib/return-to.ts`), no page changed, and no behaviour changed for a visitor who was not bounced. [contract.session-guard.md](contract.session-guard.md) |
| 2026-09-12 | v16 -> **v17** (F-093-f): `/payment/success` and `/payment/failed` exist, so a settled top-up no longer lands on a 404. They report an outcome that is already final — no call, no retry, no balance arithmetic — and the whole of both pages is how three query parameters are read. Two things are checked rather than copied: the five failure codes against `CallbackFailureCode`'s own source, and the two paths against the controller's `RESULT_PATH`. Nothing unrecognised is printed, where legacy echoed the raw query string; a missing reference is a success, where legacy called it a failure. [contract.payment-result.md](contract.payment-result.md) |
| 2026-09-12 | v15 -> **v16** (F-093-e): `/financial/deposit` exists — the last page of the wallet path, and the first in this app that *spends*. It holds no bill of its own: a gateway, an amount and a list of codes are the whole of its state, and every figure on screen is a field of `POST /deposit/quote` for exactly those, dropped the moment they change. That is F-0612 as a screen — legacy computed fee, tax, the gateway-minimum adjustment and a projected balance in the browser beside a server doing the same. Presets and the slider ceiling now come from the gateway's own range instead of six rial constants; the free path ends on this page, because nothing was minted to come back from. [contract.deposit.md](contract.deposit.md) |
| 2026-09-12 | v14 -> **v15** (F-093-g): the gift-code modal — the first thing a wallet quick action *opens* rather than navigates to, so a quick action's destination is now an `href` or a `modal`. It is the port that exists to drop a bug: legacy credited `data.amount` on every answer including a refusal, where it is undefined, so a dead code showed success over a balance of `NaN`. Here a refusal is an `ApiError` and there is no success path below it, and a redemption makes the top bar *re-read* rather than add. The five refusal sentences stay `billing`'s — each already names the box the code belongs in, so this app copies none of them and branches on no reason code. [contract.shell.md](contract.shell.md) |
| 2026-09-12 | v13 -> **v14** (F-093-d): `/financial` exists — the first page in this app to read a *list* from `billing`, and the first to use the F-093-b kit. Two tabs, because the wallet ledger and the top-up attempts are two lists and merging them is the bug F-092-n was written to undo. The URL is the whole state; `_lib/filters.ts` resolves a picked calendar day into the instants the routes take, in the viewer's zone, and builds each route's query separately. Legacy's `LoadingContext` + `Suspense`-key pair is replaced by a derived loading flag. `formatInstant` joins the kit. [contract.financial.md](contract.financial.md) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
