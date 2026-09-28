import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { FX_SOURCES, FxSource, fxSourcesFor } from './fx-source';

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
 * `FX_SOURCES_<CODE>` and `FX_SANITY_MIN_<CODE>`/`_MAX_<CODE>`, read from the
 * environment without a schema entry each (F-116-i2: 23 currencies).
 *
 * **The defaults (F-116-i2).** A currency's sources default to every source
 * this build has for it, less the ones known not to answer; its band to a
 * factor of ten either side of its rate on 2026-09-28 — wide on purpose, like
 * IRR's: the band rejects what cannot be a price, the median handles
 * disagreement, the gate a move. A currency outside this table is rated once
 * its three variables are set and this build has a source for it.
 */
interface FxCurrencyDefaults {
  sources: string;
  sanityMin: string;
  sanityMax: string;
}

/** Implemented, but seen not to answer — off until someone watches them do so. */
const OFF_BY_DEFAULT = new Set(['bitpin']);

/** USD → code on 2026-09-28 (ECB / TCMB), the centre of each default band. */
const REFERENCE: Readonly<Record<string, string>> = {
  EUR: '0.88', TRY: '49', GBP: '0.754', AED: '3.67', CNY: '6.71', JPY: '157',
  CAD: '1.42', AUD: '1.42', CHF: '0.83', SAR: '3.75', QAR: '3.65', RUB: '84',
  AZN: '1.70', KRW: '1358', SEK: '9.95', NOK: '9.5', DKK: '6.57', INR: '96',
  MYR: '4.08', THB: '33.6', HKD: '7.84', SGD: '1.28',
};

const sourcesOf = (code: string) =>
  FX_SOURCES.filter((s) => s.currency === code && !OFF_BY_DEFAULT.has(s.key))
    .map((s) => s.key)
    .join(',');

export const FX_CURRENCY_DEFAULTS: Readonly<Record<string, FxCurrencyDefaults>> = {
  // Roughly a factor of ten either side of where this market has been (F-0604).
  IRR: { sources: sourcesOf('IRR'), sanityMin: '100000', sanityMax: '10000000' },
  ...Object.fromEntries(
    Object.entries(REFERENCE).map(([code, ref]) => [
      code,
      {
        sources: sourcesOf(code),
        sanityMin: new Prisma.Decimal(ref).div(10).toString(),
        sanityMax: new Prisma.Decimal(ref).mul(10).toString(),
      },
    ]),
  ),
};

/** Every default currency, IRR first — the `FX_CURRENCIES` default. */
export const FX_DEFAULT_CURRENCIES = Object.keys(FX_CURRENCY_DEFAULTS).join(',');

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
      // `||`, not a default argument: compose passes an unset variable as ''.
      (config.get<string>('FX_CURRENCIES') || FX_DEFAULT_CURRENCIES)
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
