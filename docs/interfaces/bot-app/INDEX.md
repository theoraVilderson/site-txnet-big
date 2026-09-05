---
id: bot-app
layer: interface
status: draft
version: 1
keywords: [bot, telegram bot, bale bot, bot as a panel, bot menu, bot flow, mini app, webapp, deep link, ربات, ربات تلگرام, ربات بله, منوی ربات, ربات پنل کامل, همه قابلیت ها در ربات]
source: []
owns_tables: []
depends_on: [messenger, auth-api, i18n]
updated: 2026-09-05
---

# bot-app

**Responsibility (one sentence):** the bot as a full product surface (`D-02`,
§10.4) — conversation state and platform-agnostic screens, written **once** for
Telegram and Bale, reaching domains through the same APIs `panel-web` uses.
**Explicitly NOT responsible for:** any business rule (it decides nothing), any
Telegram/Bale difference (`messenger`), account linking and OTP delivery
(`identity` / `auth-api`, `F-0202`/`F-0203`), translation content (`i18n`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | adding a bot flow, a menu, or a deep link |
| [open-questions.md](open-questions.md) | something is undecided |

## Status

`draft`, `source: []` — nothing implements this unit. The only bot code that
exists is the `F-0203` link + OTP slice under `identity`, which ADR-0009 keeps
there deliberately. Do not describe anything here as if it works.

## Read first

[ADR-0009](../../architecture/decisions/0009-bot-is-a-surface-not-a-second-implementation.md)
(a surface, not a second implementation; chat-first) and
[ADR-0010](../../architecture/decisions/0010-bot-conversation-state-redis-navigation-postgres-commitments.md)
(where in-progress work lives). Every rule in `contract.md` follows from them.

## Changelog
| Date | Change |
|---|---|
| 2026-09-05 | Created by ADR-0009: the bot becomes a unit of its own instead of accreting inside `auth-service` |
| 2026-09-05 | Chat-first is now a rule, not a preference: the Mini App is additive and no flow may require it. Conversation state split per ADR-0010 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
