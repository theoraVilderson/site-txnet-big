---
id: messenger
layer: platform
status: active
version: 7
keywords: [telegram, bale, messenger, bot client, capability flag, degradation, inline keyboard, webapp, sendMessage, rate limit, send ceiling, bulk send, 429, محدودیت ارسال, ارسال انبوه, ربات, تلگرام, بله, قابلیت, افت قابلیت]
source:
  - txnet-backend/messenger/src/**
owns_tables: []
depends_on: [tenant, automation]
updated: 2026-09-20
---

# messenger

**Responsibility (one sentence):** the only place a Telegram/Bale difference may
appear — one driver per platform, a declared **capability set** per platform
(`F-301`), the **degradation policy** applied when a capability is missing
(`F-302`), and one renderer that turns a platform-agnostic `BotView` into that
platform's payload.
**Explicitly NOT responsible for:** conversation state or screens (`bot-app`),
any business rule, translation content (`i18n`), account linking (`identity`,
`F-0203`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | adding a platform, a capability flag, or a degradation rule |
| [contract.integrations.md](contract.integrations.md) | a bot's token, or which client a caller gets |
| [contract.send-rate.md](contract.send-rate.md) | a send is paced, refused for budget, or a new caller starts sending |
| [contract.webhook.md](contract.webhook.md) | where a bot's updates arrive, the secret-token check, or rotating a path |
| [open-questions.md](open-questions.md) | something is undecided |

## Status

`active` — an Nx library, `@txnet-backend/messenger`. Two consumers import it:
`auth-service` (OTP delivery) and, from `F-303-b`, `bot-service`. The driver,
the dated capability set, the `BotView` renderer, the deep-link adapter and —
since F-066-i — one client per `BotIntegration` exist; media sending, payments
and per-tenant branding do not.

## Changelog
| Date | Change |
|---|---|
| 2026-09-20 | v6 -> **v7** (additive, F-313-c): every sender counts against the ceiling, not just the bulk one — `sendMessage`/`sendInvoice` spend it and are never refused, and all three sending apps bind the store. Rules moved to `contract.send-rate.md` |
| 2026-09-20 | v5 -> **v6** (additive, F-313-a, ADR-0066): the outbound ceiling — one budget per (tenant x platform), spent inside `sendText`, refusing in a 429's own shape so no caller changed. Only `notification-service` binds the Redis store behind it |
| 2026-09-20 | v4 -> **v5** (additive, F-066-w5): `getMe()` and `deleteWebhook()` on the client, and `clientForToken()` — a driver for a token that is not in the vault yet, so a pasted one can be proved before it is stored. New consumer: `automation` |
| 2026-09-05 | Created by ADR-0009 as the single home for messenger differences |
| 2026-09-06 | `draft -> active`: the unit ships as the Nx library `@txnet-backend/messenger`. The ADR-0009 seed moved out of `identity`, and `capabilities.ts` / `renderer.ts` / `deep-link.ts` are new. spec: F-301 F-302 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
