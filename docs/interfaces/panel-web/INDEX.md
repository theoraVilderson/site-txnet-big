---
id: panel-web
layer: interface
status: active
version: 36
keywords: [panel, shop, buy a service, buy page, purchase, invoice, pay from wallet, not enough balance, فروشگاه, خرید سرویس, خرید, فاکتور, پرداخت از کیف پول, موجودی کافی نیست, site-pwa, user panel, register, signup, captcha, bot check, forgot password, otp channel picker, bot link, telegram link, bale link, account switcher, switch account, multi account, add account, panel session, mini app, miniapp, webapp, panel inside telegram, panel inside bale, مینی اپ, پنل داخل تلگرام, پنل داخل بله, pay inside the mini app, openInvoice, stars payment in mini app, پرداخت داخل مینی اپ, phone field, country picker, country code, dial code, فیلد شماره, انتخاب کشور, کد کشور, error message, form error, خطا نمایش داده نمیشه, ارور نشون نمیده, پیام خطا, خطا به زبان اشتباه, نمایش خطا, default language, زبان پیشفرض, سایت انگلیسی میاد, زبان اشتباه, به جای فارسی انگلیسی, DEFAULT_LANGUAGE, websocket, socket, realtime, live updates, push, reconnect, subscribe, channel, socket client, sidebar, side menu, dashboard shell, dashboard layout, mobile drawer, hamburger menu, collapse sidebar, top bar, سایدبار, منوی کناری, منوی موبایل, داشبورد پنل, ui kit, pagination, skeleton, date picker, jalali calendar, amount in words, money format, صفحه بندی, تقویم شمسی, مبلغ به حروف, wallet, wallet button, balance, top bar balance, quick actions, top up, gift code, کیف پول, موجودی, دکمه کیف پول, موجودی بالای صفحه, عملیات سریع, شارژ حساب, کد هدیه, gift modal, redeem a gift code, gift code box, وارد کردن کد هدیه, کد هدیه کجاست, top up page, top-up page, deposit page, charge wallet, add funds, amount in words on the top-up page, discount code on top-up, gateway picker, payment gateway list, صفحه شارژ, شارژ کیف پول, افزایش موجودی, واریز, انتخاب درگاه, کد تخفیف شارژ, مبلغ شارژ, financial page, financial history, transactions page, transaction list, payment history, my payments, top-up attempts, expandable row, advanced filter, date range filter, صفحه امور مالی, تاریخچه مالی, لیست تراکنش ها, گردش حساب, تراکنش هام کجاست, صفحه تراکنش ها, پرداخت های من, فیلتر پیشرفته, فیلتر تاریخ, جزئیات تراکنش, payment result, payment success page, payment failed page, back from the bank, returned from the gateway, reference number, tracking code, صفحه نتیجه پرداخت, پرداخت موفق, پرداخت ناموفق, بازگشت از بانک, کد رهگیری, gateway management, payment gateways page, merchant id, link gateway to tenant, مدیریت درگاه پرداخت, تنظیم درگاه, حذف درگاه, لینک درگاه, coupons page, discount coupons, gift codes, gift code batch, کوپن تخفیف, کد هدیه, مدیریت کوپن, catalog page, product catalog, variants, sku, price history, new price, کاتالوگ, مدیریت محصولات, قیمت محصول, تاریخچه قیمت, become a reseller, buy a reseller, buy my own panel, reseller purchase page, reseller plans, نماینده شوید, خرید نمایندگی, خرید پنل, بسته‌های نمایندگی, notifications, notification bell, bell icon, unread badge, unread count, notifications dropdown, where are my notifications, اعلان, اعلان‌ها, زنگوله, زنگوله اعلان, نشان خوانده‌نشده, تعداد خوانده‌نشده, اعلان‌هام کجاست, اعلان نمیاد, my services, services page, my subscriptions, which services do i have, where are my services, i lost my subscription key, new subscription key from the list, my configs, paste a config link to find its service, find my service by its config, پیدا کردن سرویس با لینک کانفیگ, config sync status, delete a config, purge countdown, سرویس‌های من, کانفیگ‌های من, حذف کانفیگ, صفحه سرویس‌ها, سرویس‌هام کجاست, اشتراک‌های من, کلید اشتراکم را گم کردم, کلید جدید از لیست سرویس‌ها, systems page, register a panel, holds queue, drift report, capability matrix, صفحه سامانه‌ها, ثبت پنل, صف نگه‌داشته‌ها, panel inbounds, pick inbounds, انتخاب اینباند, اینباندهای پنل, user groups, user group members, add a user to a group, گروه کاربران, گروه‌های کاربران, اعضای گروه, افزودن کاربر به گروه, discount without a code, automatic discount, discount rules page, تخفیف بدون کد, تخفیف خودکار, قانون تخفیف]
source:
  - site-pwa/src/**
owns_tables: []
depends_on: [auth-api, i18n, realtime, tenant]
updated: 2026-09-26
---

# panel-web

**Responsibility (one sentence):** the Next.js user panel (`site-pwa`) served at `panel.<domain>` and on every reseller's domain — auth screens (login / register / OTP / forgot-password), locale + theme handling, and the server-side auth-screen check (no API proxy).
**Explicitly NOT responsible for:** any business rule, auth decisions (delegated to `auth-api`), translation content (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.errors.md](contract.errors.md) | a failed call is not reaching the user, or reaches them in the wrong language |
| [contract.md](contract.md) | changing routes / the API proxy / i18n endpoints |
| [contract.origin.md](contract.origin.md) | a call or the socket reaches the wrong domain or tenant, the panel on a reseller's domain cannot sign in (F-066-u), or a host renders a bare 404 (F-066-x) |
| [contract.branding.md](contract.branding.md) | the panel shows the wrong name, logo, favicon or colours for its domain, or the platform's on a reseller's (F-066-v); a reseller editing how its configs are named in buyers' apps, `/my-resellers/:id/branding` (F-307-k) |
| [contract.realtime.md](contract.realtime.md) | the panel opens, holds or loses a WebSocket (F-070-a), an auth screen waits on an OTP delivery (F-070-b), or a signed-in screen wants live updates (F-070-c) |
| [contract.mini-app.md](contract.mini-app.md) | the panel is running inside Telegram or Bale (F-310) |
| [contract.shell.md](contract.shell.md) | a panel page gets a menu entry, a top-bar control is added, a wallet quick action opens something (F-093-g), or the sidebar / mobile drawer misbehaves (F-093-a) |
| [contract.gift-code.md](contract.gift-code.md) | the gift-code modal — a code refused, a credit shown, a free-service key that closes too easily, or one the user never copied (F-093-g, F-502-m/q) |
| [contract.shop.md](contract.shop.md) | the shop at `/shop` — the list, a coupon, buy -> invoice -> pay, a shortfall's top-up and the way back to the same invoice, the key once (F-111-e) |
| [contract.my-services.md](contract.my-services.md) | the "my services" page at `/services` — the Grants a user holds, a status pill, or a subscription key asked for again from a row (F-502-s) — **or finding a service by a config's name or a pasted config link:** [contract.service-search.md](contract.service-search.md) (F-307-n/q) |
| [contract.notifications.md](contract.notifications.md) | the bell in the top bar — its unread badge, the items it lists, the empty state, or a count that looks wrong (F-093-h) |
| [contract.kit.md](contract.kit.md) | a money page formats an amount, spells it, pages a table, picks a date, shows a skeleton or prints a timestamp (F-093-b) |
| [contract.deposit.md](contract.deposit.md) | the top-up page — its amount box, discount codes, gateway picker or bill, or a figure on it that looks wrong (F-093-e) |
| [contract.manual-payments.md](contract.manual-payments.md) | a person confirms a payment the gateway would not — the list, inquire-then-confirm, or an outcome that reads wrong (F-093-n) |
| [contract.coupons.md](contract.coupons.md) | the coupons page — the discount list, the coupon form, gift-code batches, a usage report, or a refusal that reads wrong (F-502-g/h) — **or its third tab, discounts with no code** (F-114-k) |
| [contract.catalog.md](contract.catalog.md) | the catalog page — categories and subcategories, a product in several categories, "translate into every language" (F-026-s), products, variants, a variant's panel group or "not for sale" (F-026-o), a new price or price history, or a refusal that reads wrong (F-026-f) — **or a reseller's own catalog at `/my-resellers/:id/catalog`** (F-066-w8) |
| [contract.resellers.md](contract.resellers.md) | the platform owner's reseller pages — the list and create (F-018-k), or one reseller's own page: package and period, status, its billing ledger and an adjustment (F-019-k) — **or a platform user buying a reseller of their own at `/resellers/buy`** (F-019-i) — **or a reseller's own workspace, `/my-resellers/:id/…`: its domains and its gateways** (F-066-w2/w4) |
| [contract.reseller-bot.md](contract.reseller-bot.md) | a reseller's own Telegram or Bale bot at `/my-resellers/:id/bot` — the connect form, a token the messenger refused, or a retire that reads wrong (F-066-w6) |
| [contract.payment-result.md](contract.payment-result.md) | a bank returns a payer to `/payment/success` or `/payment/failed` — a reference, an "already paid", or an error code that reads wrong (F-093-f) |
| [contract.financial.md](contract.financial.md) | the financial page's two lists, its filters, or a date range that returns the wrong day (F-093-d) |
| [contract.systems.md](contract.systems.md) | the platform owner's systems page at `/systems` — registering a panel, a verdict or capability that reads wrong, the request budget, drift acknowledge, a hold released / written off (F-027-ad), a panel group — create, edit, add a panel, drain one (F-027-bx), or a panel's inbounds — which ones a buyer is placed on, `all`/`spread`, user caps (F-114-b) |
| [contract.user-groups.md](contract.user-groups.md) | the user groups page at `/user-groups` — a group created, renamed or deleted, a member added or removed, a user who cannot be found to add, or a refusal that reads wrong (F-114-m) |
| [contract.session-guard.md](contract.session-guard.md) | a signed-in visitor is not redirected off an auth screen (F-0101) |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-26 | v35 -> **v36** (F-027-ci): `/systems` shows each value's layer (member / panel / platform), a member's own placement, cap and inbounds (`PATCH`/`PUT` on billing's member routes), and refusals naming their holder. [contract.systems.md](contract.systems.md) rules 16–17 |
<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
