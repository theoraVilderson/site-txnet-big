---
id: currency
layer: domain
status: active
version: 2
keywords: [currency, exchange rate, fx, display currency, usd rate, rial rate, dollar price, usdt, order book, exchange]
source:
  - txnet-backend/worker-service/src/app/currency/**
owns_tables: [currency, currency_exchange_rate, user_currency_preference, currency_policy]
depends_on: [identity]
updated: 2026-09-12
---

# Currency

**Responsibility (one sentence):** the display-currency layer — the currency
registry, append-only exchange rates, each user's preferred display currency,
and admin currency-lock policies.
**Explicitly NOT responsible for:** storing monetary amounts (always base
currency, `billing`), FX settlement, and *scheduling* the FX worker — the
`fx_rate_refresh` job shell and its `bot_schedule` row are `automation`'s
(`worker-service/src/app/jobs/fx-rate.job.ts`), the way `wallet/`'s edge is
billing-service's and not `billing`'s.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing currency from outside |
| [contract.fx-worker.md](contract.fx-worker.md) | touching how the USD→IRR rate is discovered (F-0603…F-0606) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |
| 2026-09-12 | `draft` -> `active`: first code (F-0603, the FX worker's poll step) |
| 2026-09-12 | `contract.fx-worker.md` v2 — F-0604: the discard/quorum/median step. Still publishes no rate |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
