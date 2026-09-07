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
updated: 2026-09-07
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
per chat, register / login / forgot / logout) and the switch group (`F-0205`,
`F-0208`, `F-0210`). Everything else in §10.4 is `todo` — not working.

## Read first

[ADR-0009](../../architecture/decisions/0009-bot-is-a-surface-not-a-second-implementation.md) (a surface, chat-first),
[ADR-0010](../../architecture/decisions/0010-bot-conversation-state-redis-navigation-postgres-commitments.md) (where in-progress work lives),
[ADR-0012](../../architecture/decisions/0012-a-contact-verified-messenger-link-is-an-authentication-factor.md) (the messenger account as a credential),
[ADR-0014](../../architecture/decisions/0014-switching-accounts-in-the-bot-moves-the-session-not-the-link.md) (a switch moves the session, not the link), [ADR-0016](../../architecture/decisions/0016-the-deployment-picks-the-bots-language-not-the-messenger.md) (the deployment picks the language, not the messenger).

## Changelog
| Date | Change |
|---|---|
| 2026-09-07 | contract v7 -> **v8**: a successful add now switches the chat onto the account it just added (`auth-api` v8 answers `userId` from both add routes). The switch + persist pair moved out of `flows/accounts.flow.ts` into `session/account-switcher.ts`, which both flows use. A refused switch falls back to the old message — the add still stands |
| 2026-09-06 | ADR-0015: the chat's switch group is scoped to the chat. Every account call carries `x-bot-platform` beside `x-bot-chat-id`, and `flows/accounts.flow.ts` gains the remove path (F-0208) — pick, confirm, done; removing the chat's own account drops the stored refresh token |
| 2026-09-06 | `F-0210` (ADR-0014): the switch group in the member menu — one tap to become another of your own accounts. The session moves; the link does not |
| 2026-09-06 | `F-0205` in the chat: an account joins the group by a code to its own phone or its own password. Adds no session and moves no link — the code goes to somebody else's number, so this flow takes the deep link rather than the in-place one |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
