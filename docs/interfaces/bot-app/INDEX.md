---
id: bot-app
layer: interface
status: active
version: 1
keywords: [bot, telegram bot, bale bot, bot as a panel, bot menu, bot flow, mini app, webapp, deep link, switch account in the bot, my accounts in the bot, add an account in the bot, ربات, ربات تلگرام, ربات بله, منوی ربات, ربات پنل کامل, همه قابلیت ها در ربات, سوییچ اکانت در ربات, تعویض حساب در ربات, حساب های من در ربات, افزودن حساب در ربات, اضافه کردن حساب تو ربات, سوییچ خودکار بعد از افزودن حساب, بعد از اضافه کردن حساب سوییچ نمیشه, حساب اضافه شد ولی وارد نشدم]
source:
  - txnet-backend/bot-service/src/**
owns_tables: []
depends_on: [messenger, auth-api, i18n]
updated: 2026-09-08
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
| [contract.accounts.md](contract.accounts.md) | the switch group: moving between accounts, whose set it is, how one joins |
| [conversation.md](conversation.md) | the shell every screen gets: orientation, Back, language, commands |
| [open-questions.md](open-questions.md) | something is undecided |

## Status

`active` — the Nx app `bot-service`. Built: `F-303` (webhook, state, a session
per chat, register/login/forgot/logout), the switch group (`F-0205`, `F-0208`,
`F-0210`) and `F-310` (the Mini App row). The rest of §10.4 is `todo`.

## Read first

[ADR-0009](../../architecture/decisions/0009-bot-is-a-surface-not-a-second-implementation.md) (a surface, chat-first),
[ADR-0010](../../architecture/decisions/0010-bot-conversation-state-redis-navigation-postgres-commitments.md) (where in-progress work lives),
[ADR-0012](../../architecture/decisions/0012-a-contact-verified-messenger-link-is-an-authentication-factor.md) (the messenger account as a credential),
[ADR-0014](../../architecture/decisions/0014-switching-accounts-in-the-bot-moves-the-session-not-the-link.md) (a switch moves the session, not the link), [ADR-0016](../../architecture/decisions/0016-the-deployment-picks-the-bots-language-not-the-messenger.md) (the deployment picks the language, not the messenger), [ADR-0017](../../architecture/decisions/0017-the-mini-app-signs-itself-in-with-the-signature-the-platform-hands-it.md) (the Mini App signs itself in).

## Changelog
| Date | Change |
|---|---|
| 2026-09-08 | Contract v9 -> **v10** (F-053): a transport failure answers with the sentence, not the key. `AuthApiClient` resolves `bot.common.tryAgain` itself, because `msg` is rendered as `raw` and `raw` is never translated again |
| 2026-09-08 | contract v8 -> **v9**: `F-310` — the Mini App is a row on the member menu (`views.ts` `miniApp()`), opening `panel-web` inside the messenger. The page signs itself in from the platform's signature (ADR-0017); this unit hands over a URL and carries no credential |
| 2026-09-07 | contract v7 -> **v8**: a successful add now switches the chat onto the account it just added (`auth-api` v8 answers `userId` from both add routes). The switch + persist pair moved out of `flows/accounts.flow.ts` into `session/account-switcher.ts`, which both flows use. A refused switch falls back to the old message — the add still stands |
| 2026-09-06 | ADR-0015: the chat's switch group is scoped to the chat. Every account call carries `x-bot-platform` beside `x-bot-chat-id`, and `flows/accounts.flow.ts` gains the remove path (F-0208) — pick, confirm, done; removing the chat's own account drops the stored refresh token |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
