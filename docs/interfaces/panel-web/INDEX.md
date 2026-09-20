---
id: panel-web
layer: interface
status: active
version: 22
keywords: [panel, site-pwa, user panel, register, signup, captcha, bot check, forgot password, otp channel picker, bot link, telegram link, bale link, account switcher, switch account, multi account, add account, panel session, mini app, miniapp, webapp, panel inside telegram, panel inside bale, مینی اپ, پنل داخل تلگرام, پنل داخل بله, pay inside the mini app, openInvoice, stars payment in mini app, پرداخت داخل مینی اپ, phone field, country picker, country code, dial code, فیلد شماره, انتخاب کشور, کد کشور, error message, form error, خطا نمایش داده نمیشه, ارور نشون نمیده, پیام خطا, خطا به زبان اشتباه, نمایش خطا, default language, زبان پیشفرض, سایت انگلیسی میاد, زبان اشتباه, به جای فارسی انگلیسی, DEFAULT_LANGUAGE, websocket, socket, realtime, live updates, push, reconnect, subscribe, channel, socket client, sidebar, side menu, dashboard shell, dashboard layout, mobile drawer, hamburger menu, collapse sidebar, top bar, سایدبار, منوی کناری, منوی موبایل, داشبورد پنل, ui kit, pagination, skeleton, date picker, jalali calendar, amount in words, money format, صفحه بندی, تقویم شمسی, مبلغ به حروف, wallet, wallet button, balance, top bar balance, quick actions, top up, gift code, کیف پول, موجودی, دکمه کیف پول, موجودی بالای صفحه, عملیات سریع, شارژ حساب, کد هدیه, gift modal, redeem a gift code, gift code box, وارد کردن کد هدیه, کد هدیه کجاست, top up page, top-up page, deposit page, charge wallet, add funds, amount in words on the top-up page, discount code on top-up, gateway picker, payment gateway list, صفحه شارژ, شارژ کیف پول, افزایش موجودی, واریز, انتخاب درگاه, کد تخفیف شارژ, مبلغ شارژ, financial page, financial history, transactions page, transaction list, payment history, my payments, top-up attempts, expandable row, advanced filter, date range filter, صفحه امور مالی, تاریخچه مالی, لیست تراکنش ها, گردش حساب, تراکنش هام کجاست, صفحه تراکنش ها, پرداخت های من, فیلتر پیشرفته, فیلتر تاریخ, جزئیات تراکنش, payment result, payment success page, payment failed page, back from the bank, returned from the gateway, reference number, tracking code, صفحه نتیجه پرداخت, پرداخت موفق, پرداخت ناموفق, بازگشت از بانک, کد رهگیری, gateway management, payment gateways page, merchant id, link gateway to tenant, مدیریت درگاه پرداخت, تنظیم درگاه, حذف درگاه, لینک درگاه, coupons page, discount coupons, gift codes, gift code batch, کوپن تخفیف, کد هدیه, مدیریت کوپن, catalog page, product catalog, variants, sku, price history, new price, کاتالوگ, مدیریت محصولات, قیمت محصول, تاریخچه قیمت, become a reseller, buy a reseller, buy my own panel, reseller purchase page, reseller plans, نماینده شوید, خرید نمایندگی, خرید پنل, بسته‌های نمایندگی]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n, realtime, tenant]
updated: 2026-09-19
---

# panel-web

**Responsibility (one sentence):** the Next.js user panel (`site-pwa`) served at
`panel.<domain>` and on every reseller's domain — auth screens (login / register / OTP / forgot-password),
locale + theme handling, and the server-side auth-screen check (no API proxy).
**Explicitly NOT responsible for:** any business rule, auth decisions (delegated
to `auth-api`), translation content (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.errors.md](contract.errors.md) | a failed call is not reaching the user, or reaches them in the wrong language |
| [contract.md](contract.md) | changing routes / the API proxy / i18n endpoints |
| [contract.origin.md](contract.origin.md) | a call or the socket reaches the wrong domain or tenant, the panel on a reseller's domain cannot sign in (F-066-u), or a host renders a bare 404 (F-066-x) |
| [contract.branding.md](contract.branding.md) | the panel shows the wrong name, logo, favicon or colours for its domain, or the platform's on a reseller's (F-066-v) |
| [contract.realtime.md](contract.realtime.md) | the panel opens, holds or loses a WebSocket (F-070-a), an auth screen waits on an OTP delivery (F-070-b), or a signed-in screen wants live updates (F-070-c) |
| [contract.mini-app.md](contract.mini-app.md) | the panel is running inside Telegram or Bale (F-310) |
| [contract.shell.md](contract.shell.md) | a panel page gets a menu entry, a top-bar control is added, a wallet quick action opens something (F-093-g), or the sidebar / mobile drawer misbehaves (F-093-a) |
| [contract.kit.md](contract.kit.md) | a money page formats an amount, spells it, pages a table, picks a date, shows a skeleton or prints a timestamp (F-093-b) |
| [contract.deposit.md](contract.deposit.md) | the top-up page — its amount box, discount codes, gateway picker or bill, or a figure on it that looks wrong (F-093-e) |
| [contract.manual-payments.md](contract.manual-payments.md) | a person confirms a payment the gateway would not — the list, inquire-then-confirm, or an outcome that reads wrong (F-093-n) |
| [contract.coupons.md](contract.coupons.md) | the coupons page — the discount list, the coupon form, gift-code batches, a usage report, or a refusal that reads wrong (F-502-g/h) |
| [contract.catalog.md](contract.catalog.md) | the catalog page — categories, products, variants, a new price or price history, or a refusal that reads wrong (F-026-f) |
| [contract.resellers.md](contract.resellers.md) | the platform owner's reseller pages — the list and create (F-018-k), or one reseller's own page: package and period, status, its billing ledger and an adjustment (F-019-k) — **or a platform user buying a reseller of their own at `/resellers/buy`** (F-019-i) — **or a reseller's own workspace, `/my-resellers/:id/…`: its domains and its gateways** (F-066-w2/w4) |
| [contract.payment-result.md](contract.payment-result.md) | a bank returns a payer to `/payment/success` or `/payment/failed` — a reference, an "already paid", or an error code that reads wrong (F-093-f) |
| [contract.financial.md](contract.financial.md) | the financial page's two lists, its filters, or a date range that returns the wrong day (F-093-d) |
| [contract.session-guard.md](contract.session-guard.md) | a signed-in visitor is not redirected off an auth screen (F-0101) |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-19 | v21 -> **v22** (F-018-ai, ADR-0063): a reseller's CNAME target is shown, not linked, on its page, and a purchase ends with "add your domain and CNAME it at <target>" instead of an "open your panel" button. [contract.resellers.md](contract.resellers.md) |
| 2026-09-19 | v20 -> **v21** (F-066-x): the panel renders nothing on a host that serves no panel — a `subscription` / `assets` domain, a gated reseller's platform subdomain. `proxy.ts` asks auth-service's `GET /api/auth/door` first and answers a bare 404 on `serves: false`; every doubt renders. [contract.origin.md](contract.origin.md) |
| 2026-09-18 | v19 -> **v20** (F-066-v, ADR-0059): the panel wears its domain's brand — name, logos, favicon, OG image, colours — read server-side by host from tenant's `GET /api/branding` (`TENANT_SERVICE_ORIGIN`), never by session; no brand is the neutral look, not the platform's. [contract.branding.md](contract.branding.md) |
| 2026-09-18 | v18 -> **v19** (F-066-u, ADR-0060): the panel calls every service at `/api/<service>` and opens the socket on the domain it was loaded from; Traefik routes those paths on every host. `NEXT_PUBLIC_API_ORIGIN` and `NEXT_PUBLIC_REALTIME_ORIGIN` are gone, the refresh cookie is host-only, and the session guard names the visitor's host. [contract.origin.md](contract.origin.md) |
| 2026-09-12 | v17 -> **v18** (F-093-i, ADR-0042): a deep link survives an expired session. The panel guard remembers the path it bounced from and the three sign-in screens return to it — in `sessionStorage`, never in a query parameter, and only ever a **relative path**, validated on the way in and on the way out, because an open `returnTo` on a sign-in screen is the classic phishing vector. Reading consumes it; a deliberate sign-out clears it. One module (`lib/return-to.ts`), no page changed, and no behaviour changed for a visitor who was not bounced. [contract.session-guard.md](contract.session-guard.md) |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
