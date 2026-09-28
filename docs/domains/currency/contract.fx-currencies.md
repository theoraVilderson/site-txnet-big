---
id: currency
layer: domain
status: active
version: 2
updated: 2026-09-28
---

# Contract — a rate for every currency (currency)

Governs **F-116-i** and **F-116-i2** (ADR-0098 part 8, D-51): the FX loop of
`contract.fx-worker.md`, run once per currency. Read that file first — its
rules (concurrency, never the mean, the gate's baseline, append-only
snapshots) hold for every currency; this one says what is per currency.

Code: `worker-service/src/app/currency/fx-currencies.ts` (which currencies,
with what), `fx-source.ts` (every source and how its book reads),
`jobs/fx-rate.job.ts` (the loop). Specs: `jobs/fx-rate.job.spec.ts`,
`currency/fx-currencies.spec.ts`.

## The loop

| step | what |
|---|---|
| 1 | `FX_CURRENCIES` (default: all 23 below), IRR moved first; one download map for the run |
| 2 | IRR alone: poll, band, median, gate, snapshot — as before |
| 3 | every other currency **concurrently**, each with IRR's rate *if this tick published one* |
| 4 | per currency: its sources, its band, the median of ≥ `FX_MIN_SOURCES`, the gate against **its own** last accepted rate, its own `currency_exchange_rate` row and `fx:rate:{code}` |

## Rules

1. **Every rate is units of the currency per one USD** (USDT read as USD,
   ADR-0098 part 6). A source declares how its book reads (`FxSource.reads`),
   next to its URL; the poller normalises with `rateOf`:

   | `reads` | the book's mid is | rate |
   |---|---|---|
   | `per-usdt` | currency per USDT (USDT/IRT in rial, USDT/EUR, USDT/TRY) | mid |
   | `toman-per-usdt` | toman per USDT (IRR only) | mid × 10 |
   | `usdt-per-unit` | USDT per unit (EUR/USDT) | 1 / mid |
   | `rial-per-unit` | an Iranian market's rial price of one unit | IRR rate / mid |
   | `toman-per-unit` | the same in toman | IRR rate / (mid × 10) |

2. **A domestic quote divides only into this tick's *accepted* USDT/IRT.** Not
   the median before the gate, not an older snapshot: if IRR was refused or
   short this tick, every `*-per-unit` source fails with "no USDT/IRT rate
   accepted this tick" and the currency stands on its foreign books.
3. **A source is read for one currency only.** `FxSource.currency` names it;
   `fxSourcesFor` refuses a key listed under another code — a USDT/IRT book
   under EUR would be a rial price read as a euro one.
4. **One currency's failure is that currency's.** A bad config, a shortfall, a
   refusal or a missing `currency` row costs that currency its rate this tick
   and nothing else. The job never throws for one; only an empty
   `FX_CURRENCIES` throws.
5. **The run's status counts currencies.** `itemsProcessed` is how many
   published; `errorsCount` adds discards, shortfalls, refusals, failures and
   uncached snapshots. None published is `failed`, some is `partial`
   (`TickConsumer.statusOf`) — a currency without a rate is never quiet.
6. **A snapshot's rate is rounded once, to the column's 8 places**
   (`DECIMAL(18,8)`, `RATE_SCALE`), before the row and the key are written, so
   both hold the same number. The median in the run log is unrounded.
7. **One download per URL per tick** (F-116-i2). tgju's table and the two
   central banks' each serve many currencies; `FxRatePoller.poll` shares a
   `FxFetches` map, and the job passes one map to every currency of a run.
   Each currency still parses the answer itself, so one bad figure is one
   source's failure.
8. **A per-unit count is part of the quote.** tgju and TCMB price the yen per
   100; tgju's count is declared per source (`TGJU_UNITS`), TCMB's `Unit` is
   read from its table. Read per 1, the yen is a hundred times wrong.
9. **A central bank's cross stays inside its own table**: ECB `X/EUR ÷
   USD/EUR`, TCMB `TRY/USD ÷ TRY/X` — neither needs this tick's IRR. A table
   dated more than `OFFICIAL_MAX_AGE_DAYS` (4) ago does not vote.
10. **A currency is choosable only while it has a rate** — `tenant`'s
   `OperatingCurrencyService` already offers only a base currency or one with a
   rate row, and a set reads the pair (`tenant/contract.currency.md`). This
   row makes EUR and TRY meet that; it adds no second check.

## The run log (`metricsJson`) — read by the alerts

```
{ published: ['IRR', 'EUR'],
  currencies: { <code>: { sources, answered, used, rate, discarded, perSource,
                          accepted?, rejected?, rejectedDeviationPercent?,
                          maxDeviationPercent?, previousRate?, snapshotId?,
                          cached?, deviationPercent?, failed? } } }
```

Each run also writes every currency's reading to `fx:reading:{code}` —
`{rate, at, outcome: accepted|refused|unavailable, used, sources, reason}`,
the median even when refused — for the manual-pin form (F-0608-a, ADR-0101
part 4). It is never a rate.

`accepted` is `true` (published), `false` (refused by the gate) or **absent**
(short, misconfigured, no row) — so a shortfall never counts as a refusal.
`currency_fx` (`postgres-queries.yaml`) reads each entry with a `currency`
label, a pre-F-116-i row as IRR's whole, and gives every active non-base
`currency` row a series, so a seeded currency never rated reads `-1`
(`CurrencyFxRateNeverAccepted`). The three rules in `currency.rules.yml` fire
per currency and name it. **Renaming `accepted`, `rejectedDeviationPercent` or
`currencies` disarms them** (`docs/operations/observability.md`).

## The sources (watched answering 2026-09-28)

| key | market | currencies | reads | from this dev host |
|---|---|---|---|---|
| `nobitex`, `tabdeal`, `wallex` | Iranian USDT/IRT books | IRR | `per-usdt` / `toman-per-usdt` | direct |
| `tgju-<code>` | tgju free-market quote (one download) | all 22 below | `rial-per-unit` | direct |
| `ecb-<code>` | ECB daily reference rates | EUR TRY GBP CNY JPY CAD AUD CHF KRW SEK NOK DKK INR MYR THB HKD SGD | cross | direct |
| `tcmb-<code>` | Central Bank of Türkiye daily rates | EUR TRY GBP AED CNY JPY CAD AUD CHF SAR QAR RUB AZN KRW SEK NOK DKK | cross | direct |
| `kucoin-eur`, `mexc-eur` | USDT/EUR, EUR/USDT books | EUR | `per-usdt` / `usdt-per-unit` | direct |
| `abantether-eur` | Abantether EUR, bid/ask | EUR | `toman-per-unit` | direct |
| `binance-eur`, `kraken-eur`, `bitstamp-eur`, `coinbase-eur` | EUR books | EUR | as declared | proxy only |
| `binance-try`, `btcturk-try`, `okx-try`, `bybit-try` | USDT/TRY books | TRY | `per-usdt` | proxy only |
| `bybit-aed` | USDT/AED book | AED | `per-usdt` | proxy only |

**Defaults** (`FX_CURRENCY_DEFAULTS`): a currency's sources are every source
this build has for it, less `OFF_BY_DEFAULT` (`bitpin`); its band is a factor
of ten either side of its 2026-09-28 rate (`REFERENCE`). Every default
currency has at least two sources (spec). **tgju is a quote, not a book** (one
price is both sides) and an unofficial endpoint, so it is one voice in a
median, never a currency's only one. The central banks are official and slow
— one figure a working day — so they are voices too, and they keep the ≥ 2 a
currency needs when the foreign books are out of reach. Abantether's
`tether_price` is ignored: it is a foreign cross.

**Left out** (user, 2026-09-28): KWD, BHD, OMR have three decimals, over the
money columns' two (ADR-0098 part 6, its revisit trigger); IQD, AFN, AMD, GEL,
TMT, TJS have one source each (tgju) and would never reach `FX_MIN_SOURCES`.

**Reachability is the node question** (`open-questions.md`): the foreign books
answer only with international internet, the domestic quotes only from inside
Iran. From the dev host the "proxy only" books answer 403 or time out; since
F-116-i2 every currency still has ≥ 2 sources that answer directly, and the
first dev tick (2026-09-28 16:45) published all 23 in 3.3s, the 9 errors being
those books. Nothing is routed through a proxy.

## Config

| knob | default | for |
|---|---|---|
| `FX_CURRENCIES` | all 23 (empty = all) | which currencies to rate; each needs a seeded `currency` row (`prisma/seed.js` has them) |
| `FX_SOURCES` | `nobitex,tabdeal,wallex` | IRR's sources (the name predates F-116-i) |
| `FX_SOURCES_<CODE>` | `FX_CURRENCY_DEFAULTS` | another currency's sources |
| `FX_SANITY_MIN_<CODE>` / `_MAX_<CODE>` | the same | its band; IRR keeps `FX_SANITY_*_RIAL` |

`FX_MIN_SOURCES` and `FX_MAX_DEVIATION_PERCENT` are shared by every currency.
The per-code variables have no schema entry each: `validateEnv` carries every
`FX_PER_CURRENCY_KEY` match through (the app skips `process.env`), empty ones dropped. A
currency outside the defaults table is rated once all three of them are set
and this build has a source for it.

## Consumers

The same as `contract.fx-worker.md`: `fx:rate:{code}` and its rows, read
through shared-core `readFxRate` / `readFxPair` (`contract.md`) — now for 23
currencies, so `billing`'s pair conversions and `tenant`'s currency choice see
them with no change of their own. `ops-observability`'s `currency_fx` query and
rules read the run log's shape above.
