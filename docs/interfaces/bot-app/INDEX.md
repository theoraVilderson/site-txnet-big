---
id: bot-app
layer: interface
status: active
version: 1
keywords: [bot, telegram bot, bale bot, bot as a panel, bot menu, bot flow, mini app, webapp, deep link, switch account in the bot, my accounts in the bot, add an account in the bot, ربات, ربات تلگرام, ربات بله, منوی ربات, ربات پنل کامل, همه قابلیت ها در ربات, سوییچ اکانت در ربات, تعویض حساب در ربات, حساب های من در ربات, افزودن حساب در ربات, اضافه کردن حساب تو ربات, سوییچ خودکار بعد از افزودن حساب, بعد از اضافه کردن حساب سوییچ نمیشه, حساب اضافه شد ولی وارد نشدم, reseller panel in the bot, manage my reseller from the bot, block a customer in the bot, sales report in the bot, پنل نمایندگی در ربات, مدیریت نمایندگی از ربات, مسدود کردن کاربر در ربات, گزارش فروش در ربات, لیست کاربران نمایندگی در ربات, bulk message in the bot, broadcast to my customers, پیام گروهی در ربات, ارسال انبوه از ربات]
source:
  - txnet-backend/bot-service/src/**
owns_tables: []
depends_on: [messenger, auth-api, i18n, tenant, billing, notification]
updated: 2026-09-20
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
| [conversation.md](conversation.md) | the shell every screen gets: orientation, Back, language, commands |
| [open-questions.md](open-questions.md) | something is undecided |

## Status

`active` — the Nx app `bot-service`. Built: `F-303` (webhook, state, a session
per chat, register/login/forgot/logout), the switch group (`F-0205`/`F-0208`/
`F-0210`), `F-310`, `F-306-a`, `F-311-c`, `F-313-b`. The rest of §10.4 is `todo`.

## Read first

[ADR-0009](../../architecture/decisions/0009-bot-is-a-surface-not-a-second-implementation.md) (a surface, chat-first), [ADR-0010](../../architecture/decisions/0010-bot-conversation-state-redis-navigation-postgres-commitments.md) (where in-progress work lives),
[ADR-0012](../../architecture/decisions/0012-a-contact-verified-messenger-link-is-an-authentication-factor.md) (the messenger account as a credential), [ADR-0014](../../architecture/decisions/0014-switching-accounts-in-the-bot-moves-the-session-not-the-link.md) (a switch moves the session, not the link), [ADR-0016](../../architecture/decisions/0016-the-deployment-picks-the-bots-language-not-the-messenger.md) (the deployment picks the language, not the messenger), [ADR-0017](../../architecture/decisions/0017-the-mini-app-signs-itself-in-with-the-signature-the-platform-hands-it.md) (the Mini App signs itself in).

## Changelog
| Date | Change |
|---|---|
| 2026-09-20 | Contract v12 -> **v13** (additive, F-313-b): the reseller's bulk message as a chat flow — segment, count, draft, confirm, watch. Rules in [contract.reseller.md](contract.reseller.md); new dependency on `notification` through `NOTIFICATION_API_BASE_URL` |
| 2026-09-20 | Contract v11 -> **v12** (additive, F-311-c): the reseller panel in the chat — a member-menu row drawn only on the door's `canRead` (F-311-e), the customer list with search and paging, block / unblock on `canWrite`, and billing's two revenue figures. New file [contract.reseller.md](contract.reseller.md); new dependency on `tenant` through `TENANT_API_BASE_URL` |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
