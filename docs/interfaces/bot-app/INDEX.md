---
id: bot-app
layer: interface
status: active
version: 1
keywords: [bot, freeze my service in the bot, unfreeze in the bot, فریز سرویس در ربات, رفع فریز در ربات, my services in the bot, service status in the bot, سرویس‌های من در ربات, وضعیت سرویس در ربات, حجم باقیمانده در ربات, support in the bot, ticket in the bot, پشتیبانی در ربات, تیکت در ربات, ارسال فایل به پشتیبانی در ربات, telegram bot, bale bot, bot as a panel, bot menu, bot flow, mini app, webapp, deep link, switch account in the bot, my accounts in the bot, add an account in the bot, ربات, ربات تلگرام, ربات بله, منوی ربات, ربات پنل کامل, همه قابلیت ها در ربات, سوییچ اکانت در ربات, تعویض حساب در ربات, حساب های من در ربات, افزودن حساب در ربات, اضافه کردن حساب تو ربات, سوییچ خودکار بعد از افزودن حساب, بعد از اضافه کردن حساب سوییچ نمیشه, حساب اضافه شد ولی وارد نشدم, reseller panel in the bot, manage my reseller from the bot, block a customer in the bot, sales report in the bot, پنل نمایندگی در ربات, مدیریت نمایندگی از ربات, مسدود کردن کاربر در ربات, گزارش فروش در ربات, لیست کاربران نمایندگی در ربات, bulk message in the bot, broadcast to my customers, پیام گروهی در ربات, ارسال انبوه از ربات, time zone in the bot, change my time zone in the bot, منطقه زمانی در ربات, تغییر منطقه زمانی در ربات, ساعت ربات اشتباهه, card to card in the bot, manual top-up in the bot, send the receipt in the bot, confirm a receipt in the bot, receipts to review, شارژ دستی در ربات, کارت به کارت در ربات, رسید در ربات, فرستادن رسید در ربات, تایید رسید در ربات, رد رسید در ربات, رسیدهای در انتظار]
source:
  - txnet-backend/bot-service/src/**
owns_tables: []
depends_on: [messenger, auth-api, i18n, tenant, billing, notification, support, guide]
updated: 2026-10-15
---

# bot-app

**Responsibility (one sentence):** the bot as a full product surface (`D-02`,
§10.4) — conversation state and platform-agnostic screens, written **once** for
Telegram and Bale, reaching domains through the same APIs `panel-web` uses.
**NOT responsible for:** business rules (it decides nothing), Telegram/Bale
differences (`messenger`), linking and OTP (`identity`/`auth-api`), copy (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | adding a bot flow, a menu, or a deep link |
| [contract.webhook.md](contract.webhook.md) | the front door: the webhook, the queue set behind it, the seam a worker runs a flow through |
| [contract.accounts.md](contract.accounts.md) | the switch group: moving between accounts, whose set it is, how one joins |
| [contract.mini-app.md](contract.mini-app.md) | the `web_app` menu row, and the `?ma=` marker that says which SDK the panel loads |
| [contract.reseller.md](contract.reseller.md) | the reseller panel in the chat: its menu row, the customers, block, the revenue figure, the bulk message |
| [contract.services.md](contract.services.md) | My services in the chat: the menu row, the list, a service's status, traffic and time (F-307-y); freezing and unfreezing one's own (F-0401-g) |
| [contract.wheel.md](contract.wheel.md) | the lucky wheel in the chat: its menu row, the odds, a spin, the prize told (F-707-h) — **or the lotteries in the chat: the list, join or leave, a ticket, the result:** [contract.lotteries.md](contract.lotteries.md) (F-707-p) |
| [contract.transfer.md](contract.transfer.md) | a card-to-card or wallet top-up in the chat: the destination, the receipt and proof, and a reviewer's one-tap confirm, send back or reject (F-805-b) |
| [contract.support.md](contract.support.md) | support in the chat: the list, a thread, a reply or a file either way, rate, reopen, the notice's Open button (F-309) — **or guides in the chat: the menu's help, the install guide by system and app, pictures and video:** [contract.guides.md](contract.guides.md) (F-414-f) |
| [conversation.md](conversation.md) | the shell every screen gets: orientation, Back, language, commands |
| [open-questions.md](open-questions.md) | something is undecided |

## Status

`active` — Nx app `bot-service`. Built: `F-303`, `F-0205`/`0208`/`0210`, `F-310`, `F-306-a`, `F-311-c`, `F-313-b`, `F-309`, `F-414-f`, `F-805-b`, `F-307-y`; the rest of §10.4 `todo`.

## Read first

[ADR-0009](../../architecture/decisions/0009-bot-is-a-surface-not-a-second-implementation.md) (a surface, chat-first), [ADR-0010](../../architecture/decisions/0010-bot-conversation-state-redis-navigation-postgres-commitments.md) (where in-progress work lives), [ADR-0012](../../architecture/decisions/0012-a-contact-verified-messenger-link-is-an-authentication-factor.md) (the messenger account as a credential), [ADR-0014](../../architecture/decisions/0014-switching-accounts-in-the-bot-moves-the-session-not-the-link.md) (a switch moves the session, not the link), [ADR-0016](../../architecture/decisions/0016-the-deployment-picks-the-bots-language-not-the-messenger.md) (the deployment picks the language, not the messenger), [ADR-0017](../../architecture/decisions/0017-the-mini-app-signs-itself-in-with-the-signature-the-platform-hands-it.md) (the Mini App signs itself in).

## Changelog
| Date | Change |
|---|---|
| 2026-10-15 | Contract v17 -> **v18** (additive, F-0401-g): the user freezes and unfreezes their own metered service from its screen in the chat, asked first; who froze it and the daily cap are named. Rules 9–13 of [contract.services.md](contract.services.md) |
| 2026-10-15 | Contract v16 -> **v17** (additive, F-307-y): My services in the chat — a `🛡 My services` row first on the member menu, the list and a service's screen over billing's `GET /api/billing/gift/grants`. Rules in [contract.services.md](contract.services.md) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
