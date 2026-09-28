import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { FxSource, fxSourcesFor } from './fx-source';

/**
 * F-116-i (ADR-0098 part 8, D-51) — which currencies the FX loop rates, and
 * with what. Each currency is its own sample: its own source list, its own
 * hard sanity band (in units of **that** currency per USD), and — in the job —
 * its own median and its own deviation gate against its own last accepted
 * rate. `FX_MIN_SOURCES` and `FX_MAX_DEVIATION_PERCENT` are shared: they are
 * judgements about a median, not about a market.
 *
 * IRR keeps the env names it has had since F-0603 (`FX_SOURCES`,
 * `FX_SANITY_MIN_RIAL`/`_MAX_RIAL`); every other currency is
 * `FX_SOURCES_<CODE>` and `FX_SANITY_MIN_<CODE>`/`_MAX_<CODE>`.
 *
 * The defaults below are the build's; a currency not in this table can still
 * be rated by setting all three of its variables, as long as this build has a
 * source for it (`fx-source.ts`).
 */
interface FxCurrencyDefaults {
  sources: string;
  sanityMin: string;
  sanityMax: string;
}

export const FX_CURRENCY_DEFAULTS: Readonly<Record<string, FxCurrencyDefaults>> = {
  // Roughly a factor of ten either side of where this market has been (F-0604).
  IRR: { sources: 'nobitex,tabdeal,wallex', sanityMin: '100000', sanityMax: '10000000' },
  // Wide for the same reason: it rejects what cannot be a price (an amount
  // column, a book read upside down is 1.14 against 0.88 and still in band —
  // that is `reads`' job and F-0605's), never disagreement.
  EUR: {
    sources: 'binance-eur,kraken-eur,bitstamp-eur,coinbase-eur,tgju-eur,abantether-eur',
    sanityMin: '0.3',
    sanityMax: '3',
  },
  TRY: {
    sources: 'binance-try,btcturk-try,okx-try,bybit-try,tgju-try',
    sanityMin: '3',
    sanityMax: '1000',
  },
};

/** The rial loop runs first: the others' `rial-per-unit` sources divide by it. */
export const FX_DOMESTIC_CODE = 'IRR';

export interface FxCurrencyConfig {
  code: string;
  sources: FxSource[];
  sanityMin: Prisma.Decimal;
  sanityMax: Prisma.Decimal;
}

const envNames = (code: string) =>
  code === FX_DOMESTIC_CODE
    ? { sources: 'FX_SOURCES', min: 'FX_SANITY_MIN_RIAL', max: 'FX_SANITY_MAX_RIAL' }
    : { sources: `FX_SOURCES_${code}`, min: `FX_SANITY_MIN_${code}`, max: `FX_SANITY_MAX_${code}` };

/**
 * The currencies to rate this run, IRR first. Throws only when the list itself
 * is empty — a run with nothing to rate is a failed run (automation invariant
 * #3). A currency whose own config is wrong is not a throw here: it is
 * `fxCurrencyConfig`'s, and costs that currency alone.
 */
export function fxCurrencies(config: ConfigService): string[] {
  const codes = [
    ...new Set(
      config
        .get<string>('FX_CURRENCIES', 'IRR,EUR,TRY')
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  if (codes.length === 0) throw new Error('FX_CURRENCIES is empty — no currency to rate');
  return codes.sort((a, b) => Number(b === FX_DOMESTIC_CODE) - Number(a === FX_DOMESTIC_CODE));
}

/**
 * One currency's sources and band, read at run time (a job's own
 * configuration being wrong must cost that job its runs and nothing else —
 * here, that currency its rate and nothing else). Throws with a readable
 * reason; the job records it as that currency's failure.
 */
export function fxCurrencyConfig(config: ConfigService, code: string): FxCurrencyConfig {
  const names = envNames(code);
  const defaults = FX_CURRENCY_DEFAULTS[code];
  const keys = (config.get<string>(names.sources) || defaults?.sources || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) throw new Error(`${names.sources} is empty — no source to poll for ${code}`);

  const min = config.get<string>(names.min) || defaults?.sanityMin;
  const max = config.get<string>(names.max) || defaults?.sanityMax;
  if (!min || !max) throw new Error(`${code} has no sanity band — set ${names.min} and ${names.max}`);

  return {
    code,
    sources: fxSourcesFor(code, keys),
    sanityMin: new Prisma.Decimal(min),
    sanityMax: new Prisma.Decimal(max),
  };
}
