---
id: currency
layer: domain
status: draft
version: 1
keywords: [currency, exchange rate, fx, display currency]
source: []
owns_tables: [currency, currency_exchange_rate, user_currency_preference, currency_policy]
depends_on: [identity]
updated: 2026-09-04
---

# Currency

**Responsibility (one sentence):** the display-currency layer — the currency
registry, append-only exchange rates, each user's preferred display currency,
and admin currency-lock policies.
**Explicitly NOT responsible for:** storing monetary amounts (always base
currency, `billing`), FX settlement.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing currency from outside |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
