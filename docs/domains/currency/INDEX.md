---
id: currency
layer: domain
status: active
version: 4
keywords: [manual rate, pin rate, fixed rate, emergency rate, pound rate, dirham rate, yen rate, ecb, tcmb, currency, exchange rate, fx, display currency, usd rate, rial rate, dollar price, usdt, order book, exchange, euro rate, lira rate, eur, try, tgju]
source:
  - txnet-backend/currency-service/src/**
  - txnet-backend/worker-service/src/app/currency/**
  - txnet-backend/shared-core/src/lib/currency/**
owns_tables: [currency, currency_exchange_rate, user_currency_preference, currency_policy]
depends_on: [identity]
updated: 2026-09-28
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
| [contract.md](contract.md) | using or changing currency from outside — reading a rate or a pair (F-116-c), the `/api/currency` routes (F-116-k) |
| [contract.fx-worker.md](contract.fx-worker.md) | touching how a rate is discovered — poll, median, gate, snapshot (F-0603…F-0606) |
| [contract.fx-currencies.md](contract.fx-currencies.md) | adding a currency or a source, or reading the run log per currency (F-116-i, F-116-i2) |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage — rates, pins and their ends |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-28 | `contract.md` v2 — F-116-c: **one rate reader for every service**, shared-core `readFxRate` / `readFxPair`: any pair through the USD pivot, `rate(to)/rate(from)` at one snapshot per leg (ADR-0098 part 6). Billing's `FxRateReader` delegates to it |
| 2026-09-28 | `contract.fx-worker.md` v5 + new `contract.fx-currencies.md` — F-116-i: **the loop runs per currency** (`FX_CURRENCIES`, default IRR, EUR, TRY), domestic quotes divided into the tick's accepted USDT/IRT. Run-log shape changed to `metricsJson.currencies.<code>`; `currency_fx` and the alerts are labelled per currency. `FX_QUOTE_CURRENCY_CODE` removed |
| 2026-09-28 | `contract.fx-currencies.md` v2 — F-116-i2: **23 currencies** by default; tgju, ECB and TCMB serve many currencies from one download a tick (per-unit counts, stale official tables refused); KuCoin/MEXC for EUR. `FX_SOURCES_EUR`/`_TRY` left the env schema (carried by pattern) |
| 2026-09-28 | `contract.md` v3 — F-116-k: **`currency-service`**, the unit's HTTP home (ADR-0100); `GET /api/currency/rates` |
| 2026-09-28 | `contract.md` v4 — F-0608-a: **the platform's manual rate** (ADR-0101): pin / end / form routes; `readFxRate` answers a live pin first and reads discovered rows only from the table; `currency_rate_pin_end`; `fx:reading:{code}` |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
