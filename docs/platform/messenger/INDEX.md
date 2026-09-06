---
id: messenger
layer: platform
status: active
version: 1
keywords: [telegram, bale, messenger, bot client, capability flag, degradation, inline keyboard, webapp, sendMessage, ربات, تلگرام, بله, قابلیت, افت قابلیت]
source:
  - txnet-backend/messenger/src/**
owns_tables: []
depends_on: [tenant]
updated: 2026-09-06
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
| [open-questions.md](open-questions.md) | something is undecided |

## Status

`active` — an Nx library, `@txnet-backend/messenger`. Two consumers import it:
`auth-service` (OTP delivery) and, from `F-303-b`, `bot-service`. The driver,
the dated capability set, the `BotView` renderer and the deep-link adapter
exist; media sending, payments and per-tenant branding do not.

## Changelog
| Date | Change |
|---|---|
| 2026-09-05 | Created by ADR-0009 as the single home for messenger differences |
| 2026-09-05 | Webhook addressing settled: one unguessable path per bot, not one shared door |
| 2026-09-05 | Capability table verified against docs.bale.ai. The catalog's "Bale is a subset" premise does not hold: the divergence is **shape** (base URL, deep link, global name, payment rails), not missing capability. See ADR-0009's amendment |
| 2026-09-06 | `draft -> active`: the unit ships as the Nx library `@txnet-backend/messenger`. The ADR-0009 seed moved out of `identity`, and `capabilities.ts` / `renderer.ts` / `deep-link.ts` are new. spec: F-301 F-302 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
