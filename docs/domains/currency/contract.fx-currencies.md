---
id: currency
layer: domain
status: active
version: 1
updated: 2026-09-28
---

# Contract — a rate for every currency (currency)

Governs **F-116-i** (ADR-0098 part 8, D-51): the FX loop of
`contract.fx-worker.md`, run once per currency. Read that file first — its
rules (concurrency, never the mean, the gate's baseline, append-only
snapshots) hold for every currency; this one says what is per currency.

Code: `worker-service/src/app/currency/fx-currencies.ts` (which currencies,
with what), `fx-source.ts` (every source and how its book reads),
`jobs/fx-rate.job.ts` (the loop). Spec: `jobs/fx-rate.job.spec.ts`.

## The loop

| step | what |
|---|---|
| 1 | `FX_CURRENCIES` (default `IRR,EUR,TRY`), IRR moved first |
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
7. **A currency is choosable only while it has a rate** — `tenant`'s
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

`accepted` is `true` (published), `false` (refused by the gate) or **absent**
(short, misconfigured, no row) — so a shortfall never counts as a refusal.
`currency_fx` (`postgres-queries.yaml`) reads each entry with a `currency`
label, a pre-F-116-i row as IRR's whole, and gives every active non-base
`currency` row a series, so a seeded currency never rated reads `-1`
(`CurrencyFxRateNeverAccepted`). The three rules in `currency.rules.yml` fire
per currency and name it. **Renaming `accepted`, `rejectedDeviationPercent` or
`currencies` disarms them** (`docs/operations/observability.md`).

## The sources (watched answering 2026-09-28)

| currency | key | market | reads | from this dev host |
|---|---|---|---|---|
| IRR | `nobitex`, `tabdeal`, `wallex` | Iranian USDT/IRT books | `per-usdt` / `toman-per-usdt` | direct |
| EUR | `binance-eur` | Binance EUR/USDT | `usdt-per-unit` | proxy only |
| EUR | `kraken-eur`, `bitstamp-eur`, `coinbase-eur` | USDT/EUR books | `per-usdt` | proxy only |
| EUR | `tgju-eur` | tgju free-market quote | `rial-per-unit` | direct |
| EUR | `abantether-eur` | Abantether EUR, bid/ask | `toman-per-unit` | direct |
| TRY | `binance-try`, `btcturk-try`, `okx-try`, `bybit-try` | USDT/TRY books | `per-usdt` | proxy only |
| TRY | `tgju-try` | tgju free-market quote | `rial-per-unit` | direct |

Defaults and bands (`FX_CURRENCY_DEFAULTS`): EUR 0.3–3, TRY 3–1000 per USD —
wide, like IRR's: the band rejects what cannot be a price, the median handles
disagreement, the gate a move. **tgju is a quote, not a book** (one price is
both sides) and an unofficial endpoint, so it is one voice in a median, never a
currency's only one. Abantether's `tether_price` is ignored: it is a foreign
cross, and the point of a domestic source is not to need one.

**Reachability is the node question** (`open-questions.md`): the foreign books
answer only with international internet, the domestic quotes only from inside
Iran. From the dev host the foreign books answer 403 or time out without the
host's HTTPS proxy, so EUR stands on `tgju-eur` + `abantether-eur` and TRY has
one domestic voice — short of `FX_MIN_SOURCES`, no TRY rate, and the alert says
so. Nothing is routed through a proxy yet.

## Config

| knob | default | for |
|---|---|---|
| `FX_CURRENCIES` | `IRR,EUR,TRY` | which currencies to rate; each needs a seeded `currency` row |
| `FX_SOURCES` | `nobitex,tabdeal,wallex` | IRR's sources (the name predates F-116-i) |
| `FX_SOURCES_<CODE>` | `FX_CURRENCY_DEFAULTS` | another currency's sources |
| `FX_SANITY_MIN_<CODE>` / `_MAX_<CODE>` | the same | its band; IRR keeps `FX_SANITY_*_RIAL` |

`FX_MIN_SOURCES` and `FX_MAX_DEVIATION_PERCENT` are shared by every currency.
A currency outside the defaults table is rated once all three of its
variables are set and this build has a source for it.

## Consumers

The same as `contract.fx-worker.md`: `fx:rate:{code}` and its rows, read
through shared-core `readFxRate` / `readFxPair` (`contract.md`) — now for EUR
and TRY too, so `billing`'s pair conversions and `tenant`'s currency choice see
them with no change of their own. `ops-observability`'s `currency_fx` query and
rules read the run log's shape above.
